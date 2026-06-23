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
  normal: '普通信号',
  accel:  '加速信号',
  quasi:  '准极端信号',
  extreme: '极端底部信号',
};

// ── 消息构建 ──────────────────────────────────────────────────────────────

const SEP = '─'.repeat(20);

function buildMessage(ctx) {
  const { trigger, cycleScore, price, budget, poolRemaining, strategyDoc, local } = ctx;
  const s = strategyDoc?.strategy ?? {};

  const priceStr = price ? `BTC ${fmtUSD(price)}` : '';
  const scoreStr = `周期分 ${cycleScore}/100（${scoreZone(cycleScore)}）`;
  const marketLine = [priceStr, scoreStr].filter(Boolean).join(' · ');

  // ── 数据过期 ──
  if (trigger.trigger === 'stale') {
    return [
      '【BTC 定投早报】',
      '',
      '⚠️ 链上数据超过 48 小时未更新，信号判断暂停。',
      '时间型定投今天照常执行，信号型跳过。',
      '',
      '请检查 GitHub Actions 是否正常运行。',
    ].join('\n');
  }

  // ── 无触发 ──
  if (trigger.trigger === 'none') {
    return [
      '【BTC 定投早报】',
      '',
      '今天：观望，不操作',
      '',
      marketLine,
      '条件未达触发门槛，按原计划等待。',
    ].join('\n');
  }

  // ── 时间触发（定投日）──
  if (trigger.trigger === 'time_base') {
    const freq         = s.dca_frequency || 'biweekly';
    const totalBatches = freq === 'weekly' ? 34 : 17;
    const batchesDone  = trigger.trades_count ?? 0;
    const remaining    = Math.max(1, totalBatches - batchesDone);
    const perBatch     = budget > 0 ? Math.round(poolRemaining.base / remaining) : 0;
    const batchLabel   = `第 ${batchesDone + 1}/${totalBatches} 次`;

    const parts = ['【BTC 定投早报】', ''];

    if (perBatch > 0) {
      parts.push(`今天：买入 ${fmtCNY(perBatch)}`, '');
      parts.push(`打开交易所，买入约 ${fmtCNY(perBatch)} 的 BTC`);
    } else {
      parts.push('今天：定投日', '');
      parts.push('打开交易所，按策略金额买入 BTC');
    }
    parts.push('买完回复：已买入 @成交价（例：已买入 @66200）');
    parts.push('');
    parts.push(SEP);
    parts.push(marketLine);
    parts.push(`基础仓位 ${batchLabel}，剩余额度 ${fmtCNY(poolRemaining.base)}`);
    return parts.join('\n');
  }

  // ── 信号触发 ──
  if (trigger.trigger.startsWith('signal_')) {
    const level     = trigger.signal_level;
    const execPct   = trigger.exec_pct ?? 0;
    const isExtreme = level === 'quasi' || level === 'extreme';
    const pool      = isExtreme ? poolRemaining.extreme : poolRemaining.signal;
    const poolLabel = isExtreme ? '加仓弹药' : '信号弹药';
    const amount    = budget > 0 ? Math.round(pool * execPct) : 0;

    const SIGNAL_DESC = {
      normal:  '链上多项指标低估，触发加仓',
      accel:   '多指标深度低估共振，加速加仓',
      quasi:   '接近历史极端底部，重点加仓',
      extreme: '历史级别极端底部，集中加仓',
    };

    const parts = ['【BTC 定投早报】', ''];

    if (amount > 0) {
      parts.push(`今天：${LEVEL_LABEL[level] ?? '信号触发'}，买入 ${fmtCNY(amount)}`, '');
      parts.push(`打开交易所，买入约 ${fmtCNY(amount)} 的 BTC`);
    } else {
      parts.push(`今天：${LEVEL_LABEL[level] ?? '信号触发'}`, '');
      parts.push('打开交易所，按策略金额买入 BTC');
    }
    parts.push('买完回复：已买入 @成交价（例：已买入 @66200）');
    parts.push('');
    parts.push(SEP);
    parts.push(marketLine);
    parts.push(SIGNAL_DESC[level] ?? '');
    if (amount > 0) {
      parts.push(`${poolLabel}剩余 ${fmtCNY(pool)}，本次动用 ${(execPct * 100).toFixed(0)}%`);
    }
    return parts.join('\n');
  }

  // ── 错误 ──
  return `⚠️ 状态异常：${trigger.trigger}\n${trigger.reason ?? ''}`;
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
