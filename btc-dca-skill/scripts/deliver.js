#!/usr/bin/env node
/**
 * deliver.js — 格式化并发送定投提醒
 *
 * stdin:  JSON from check-triggers.js
 * 读取：  ~/.btc-dca/config.json、local.json、execution-log.json
 * 推送：  Telegram Bot API 或 stdout（fallback）
 *
 * 参数：
 *   --verbose   无触发时也输出状态摘要
 *   --dry-run   只打印消息，不实际发送
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.btc-dca');

async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readDotEnv() {
  try {
    const raw = await readFile(join(CONFIG_DIR, '.env'), 'utf8');
    return Object.fromEntries(
      raw.split('\n')
         .filter(l => l.includes('='))
         .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    );
  } catch {
    return {};
  }
}

// ── 格式化工具 ────────────────────────────────────────────────────────────

function fmtCNY(cny) {
  if (Math.abs(cny) >= 10000) return `${(cny / 10000).toFixed(1)} 万元`;
  return `${Math.round(cny).toLocaleString('zh-CN')} 元`;
}
function fmtUSD(usd) { return `$${Math.round(usd).toLocaleString('en-US')}`; }
function fmtPct(r)   { return (r >= 0 ? '+' : '') + (r * 100).toFixed(1) + '%'; }

function scoreZone(score) {
  if (score < 25) return '极端底部区';
  if (score < 45) return '熊市积累区';
  if (score < 70) return '震荡中性区';
  return '高估预警区';
}

const LEVEL_LABEL = {
  normal:  '普通信号',
  accel:   '加速信号',
  quasi:   '准极端信号',
  extreme: '极端底部信号',
};

// ── 日期工具 ──────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDateCN(iso) {
  const d = new Date(iso + 'T12:00:00');
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
}

function fmtShortDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 双周定投的当前期 */
function biweeklyPeriod(today) {
  const d   = new Date(today + 'T12:00:00');
  const y   = d.getFullYear();
  const m   = d.getMonth() + 1;
  const day = d.getDate();
  const pad = n => String(n).padStart(2, '0');

  if (day < 15) {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return {
      label:       `${m}月1日—${m}月14日`,
      startISO:    `${y}-${pad(m)}-01`,
      dcaDate:     `${m}月1日`,
      nextDcaDate: `${m}月15日`,
    };
  } else {
    const lastDay = new Date(y, m, 0).getDate();
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return {
      label:       `${m}月15日—${m}月${lastDay}日`,
      startISO:    `${y}-${pad(m)}-15`,
      dcaDate:     `${m}月15日`,
      nextDcaDate: ny !== y ? `${ny}年${nm}月1日` : `${nm}月1日`,
    };
  }
}

/** 周投的当前期（从上次买入日算起 7 天） */
function weeklyPeriod(lastBaseTrade, today) {
  if (!lastBaseTrade) {
    return { label: '第一周期', startISO: today, dcaDate: '今天', nextDcaDate: '今天' };
  }
  const start = new Date(lastBaseTrade.date + 'T12:00:00');
  const next  = new Date(start);
  next.setDate(next.getDate() + 7);
  const endD = new Date(next);
  endD.setDate(endD.getDate() - 1);
  return {
    label:       `${fmtShortDate(lastBaseTrade.date)}—${fmtShortDate(endD.toISOString().slice(0, 10))}`,
    startISO:    lastBaseTrade.date,
    dcaDate:     fmtShortDate(lastBaseTrade.date),
    nextDcaDate: fmtShortDate(next.toISOString().slice(0, 10)),
  };
}

// ── 消息构建 ──────────────────────────────────────────────────────────────

const SEP = '────────────────────';

const SIGNAL_WHY = {
  normal:  '链上多项指标进入低估区，条件共振触发',
  accel:   '多指标深度低估共振，加速建仓',
  quasi:   '接近历史极端底部，重点加仓',
  extreme: '历史级别极端底部，集中加仓',
};

/** 冷静期结束日（today + n 天）→ "X月X日" */
function cooldownEndDate(today, days) {
  const d = new Date(today + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return fmtShortDate(d.toISOString().slice(0, 10));
}

function buildMessage(ctx) {
  const { trigger, cycleScore, price, budget, poolRemaining, strategyDoc, local, execLog, today } = ctx;
  const s       = strategyDoc?.strategy ?? {};
  const trades  = execLog?.trades ?? [];
  const freq    = s.dca_frequency ?? 'biweekly';
  const totalBatches = freq === 'weekly' ? 34 : 17;
  const freqLabel    = freq === 'weekly' ? '每周' : '每两周';

  const L = [];
  const ln = (...args) => args.forEach(s => L.push(s));

  // ── 数据过期 ──
  if (trigger.trigger === 'stale') {
    ln(
      `📅 BTC 定投日报 · ${fmtDateCN(today)}`,
      SEP,
      '⚠️ 链上数据超过 48 小时未更新，信号判断暂停。',
      '时间型定投今天照常执行，信号型跳过。',
      '',
      '请检查 GitHub Actions 是否正常运行。',
    );
    return L.join('\n');
  }

  // ── 标题 ──
  ln(`📅 BTC 定投日报 · ${fmtDateCN(today)}`);

  // ────────────────────────────────────────
  // 分区 ① 基础定投
  // ────────────────────────────────────────
  const lastBase   = [...trades].reverse().find(t => t.pool === 'base');
  const period     = freq === 'biweekly' ? biweeklyPeriod(today) : weeklyPeriod(lastBase, today);
  const periodBuys = trades.filter(t => t.pool === 'base' && t.date >= period.startISO);
  const batchesDone = trades.filter(t => t.pool === 'base').length;

  ln(SEP, `🗓️ 基础定投  ${period.label}`);

  if (trigger.time_trigger_active) {
    const remaining = Math.max(1, totalBatches - batchesDone);
    const perBatch  = budget > 0 ? Math.round(poolRemaining.base / remaining) : 0;
    ln(`今天是本期定投日（${freqLabel}）`, '');
    if (perBatch > 0) ln(`👉 买入约 ${fmtCNY(perBatch)}（第 ${batchesDone + 1}/${totalBatches} 批）`);
    if (perBatch > 0 && budget > 0) ln(`基础池剩余 ${fmtCNY(poolRemaining.base)}`);
  } else if (periodBuys.length > 0) {
    const done     = periodBuys[0];
    const priceTag = done.price_usd ? `（@${fmtUSD(done.price_usd)}）` : '';
    ln(`✅ 本期已完成：${fmtShortDate(done.date)} 买入 ${fmtCNY(done.amount_cny)}${priceTag}`);
    ln(`下次定投日：${period.nextDcaDate}`);
  } else {
    ln(`⏳ 等待定投日：${period.dcaDate}`);
    if (budget > 0 && totalBatches > batchesDone) {
      const est = Math.round(poolRemaining.base / Math.max(1, totalBatches - batchesDone));
      ln(`预计每批约 ${fmtCNY(est)}`);
    }
  }

  // ────────────────────────────────────────
  // 分区 ② 信号池
  // ────────────────────────────────────────
  const signalLevel  = trigger.signal_level ?? 'none';
  const cooldownLeft = trigger.signal_cooldown_remaining ?? 0;
  const signalActive = trigger.signal_trigger_active ?? false;
  const isExtreme    = signalLevel === 'quasi' || signalLevel === 'extreme';
  const signalPool   = isExtreme ? poolRemaining.extreme : poolRemaining.signal;
  const signalPoolLabel = isExtreme ? '极端池' : '信号池';

  if (signalActive) {
    const execPct = trigger.exec_pct ?? 0;
    const amount  = budget > 0 ? Math.round(signalPool * execPct) : 0;
    ln(SEP, `⚡ 信号池  ${LEVEL_LABEL[signalLevel] ?? signalLevel}触发`);
    ln(SIGNAL_WHY[signalLevel] ?? '', '');
    if (amount > 0) ln(`👉 立即买入约 ${fmtCNY(amount)}`);
    if (amount > 0 && budget > 0) {
      ln(`${signalPoolLabel}剩余 ${fmtCNY(signalPool)}，本次动用 ${(execPct * 100).toFixed(0)}%`);
    }
  } else if (signalLevel !== 'none' && cooldownLeft > 0) {
    const endDate = cooldownEndDate(today, cooldownLeft);
    ln(SEP, `⚡ 信号池  ${LEVEL_LABEL[signalLevel]}冷静期`);
    ln(`还剩 ${cooldownLeft} 天（下次检测：${endDate}）`);
  } else {
    ln(SEP, '⚡ 信号池  未触发');
    ln(`周期分 ${cycleScore}/100，信号门槛 ≤ 28 分`);
    if (cycleScore <= 35) ln('（基础定投窗口已开启，信号等待更深共振）');
  }

  // ────────────────────────────────────────
  // 分区 ③ 市场
  // ────────────────────────────────────────
  ln(SEP, '📊 市场');
  if (price) ln(`BTC ${fmtUSD(price)}`);
  ln(`周期分 ${cycleScore}/100（${scoreZone(cycleScore)}）`);

  if (budget > 0) {
    const poolLine = [
      `基础池 ${fmtCNY(poolRemaining.base)}`,
      `信号池 ${fmtCNY(poolRemaining.signal)}`,
      `极端池 ${fmtCNY(poolRemaining.extreme)}`,
    ].join(' · ');
    ln(poolLine);
  }

  // 持仓快照
  const avgCost = execLog?.summary?.avg_cost_usd ?? 0;
  const totalBtc = execLog?.summary?.total_btc  ?? 0;
  if (price && avgCost > 0 && totalBtc > 0) {
    const pnl = (price - avgCost) / avgCost;
    ln(`持仓：${totalBtc.toFixed(6)} BTC · 均价 ${fmtUSD(avgCost)} · 账面 ${fmtPct(pnl)}`);
  }

  return L.join('\n');
}

function buildDrawdownMessage(pnlPct, local, trigger) {
  const declaration = local?.self_declaration ?? '';
  const cycleScore  = trigger?.cycle_score ?? '-';
  const pct         = Math.abs(pnlPct * 100).toFixed(1);

  if (Math.abs(pnlPct) >= 0.5 && declaration) {
    return [
      `【重要提醒 · 账面深度亏损 -${pct}%】`,
      '',
      '现在展示你在制定策略时写下的话：',
      '',
      '———',
      declaration,
      '———',
      '',
      `当前周期评分：${cycleScore} 分`,
      '',
      '按规则执行，不要临场判断。',
    ].join('\n');
  }

  return [
    `【持仓提醒 · 账面浮亏 -${pct}%】`,
    '',
    '这在策略预期范围内。',
    `当前周期评分：${cycleScore} 分`,
  ].join('\n');
}

// ── Telegram 发送 ─────────────────────────────────────────────────────────

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text }),
    signal:  AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram ${res.status}: ${body}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const dryRun  = args.includes('--dry-run');

  // 读 stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const trigger = JSON.parse(chunks.join(''));

  // 无触发时静默（除非 --verbose）
  if (trigger.trigger === 'none' && !verbose) return;

  const [config, local, execLog, env] = await Promise.all([
    readJSON(join(CONFIG_DIR, 'config.json'), {}),
    readJSON(join(CONFIG_DIR, 'local.json'),  {}),
    readJSON(join(CONFIG_DIR, 'execution-log.json'), { trades: [], skips: [] }),
    readDotEnv(),
  ]);

  // 推送暂停检查
  if (config.notifications?.paused_until && !verbose) {
    const until = new Date(config.notifications.paused_until);
    if (Date.now() < until.getTime()) {
      process.stderr.write(`[deliver] 推送已暂停至 ${config.notifications.paused_until}\n`);
      return;
    }
  }

  const budget   = local?.precise_budget ?? 0;
  const trades   = execLog.trades ?? [];
  const strategyDoc = trigger.strategy ?? {};
  const s        = strategyDoc.strategy ?? {};

  // 计算各池剩余金额
  const basePct    = (s.base_bullet_pct    ?? 15) / 100;
  const signalPct  = (s.signal_bullet_pct  ?? 30) / 100;
  const extremePct = (s.extreme_bullet_pct ?? 55) / 100;
  const poolRemaining = {
    base:    Math.max(0, budget * basePct    - (trigger.pool_used?.base    ?? 0)),
    signal:  Math.max(0, budget * signalPct  - (trigger.pool_used?.signal  ?? 0)),
    extreme: Math.max(0, budget * extremePct - (trigger.pool_used?.extreme ?? 0)),
  };

  const price = trigger.signal_data?.binance?.currentPrice
    ?? trigger.signal_data?.feed?.current_price
    ?? null;

  const message = buildMessage({
    trigger, cycleScore: trigger.cycle_score, price,
    budget, poolRemaining, strategyDoc, local,
    execLog, today: todayStr(),
  });

  // ── 浮亏预警检查（如有持仓且当前价可用）──
  const avgCostUsd = execLog.summary?.avg_cost_usd ?? 0;
  const totalBtc   = execLog.summary?.total_btc    ?? 0;
  let drawdownMsg  = null;

  if (price && avgCostUsd > 0 && totalBtc > 0) {
    const pnlPct = (price - avgCostUsd) / avgCostUsd;
    const alertsSent = execLog.summary?.drawdown_alerts_sent ?? [];
    if (pnlPct <= -0.5 && !alertsSent.includes(50)) drawdownMsg = buildDrawdownMessage(pnlPct, local, trigger);
    else if (pnlPct <= -0.3 && !alertsSent.includes(30)) drawdownMsg = buildDrawdownMessage(pnlPct, local, trigger);
  }

  // ── 发送 ──
  const telegramToken  = env.TELEGRAM_TOKEN  ?? process.env.TELEGRAM_TOKEN  ?? '';
  const telegramChatId = env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID ?? '';
  const usesTelegram   = config.delivery?.method === 'telegram' && telegramToken && telegramChatId;

  if (dryRun || !usesTelegram) {
    console.log('\n' + '─'.repeat(52));
    console.log(message);
    if (drawdownMsg) { console.log('\n' + '─'.repeat(52)); console.log(drawdownMsg); }
    console.log('─'.repeat(52) + '\n');
  } else {
    await sendTelegram(telegramToken, telegramChatId, message);
    if (drawdownMsg) await sendTelegram(telegramToken, telegramChatId, drawdownMsg);
    process.stderr.write('[deliver] 推送已发送 via Telegram\n');
  }
}

main().catch(err => {
  process.stderr.write(`[deliver] ${err.message}\n`);
  process.exit(1);
});
