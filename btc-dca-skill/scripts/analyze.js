#!/usr/bin/env node
/**
 * analyze.js — 分析当前定投状态，输出人类可读的状态报告
 *
 * 读取：~/.btc-dca/strategy.json、local.json、execution-log.json
 * 实时拉取 Binance 现价用于盈亏计算
 *
 * 参数：
 *   --json   以 JSON 格式输出（供程序消费）
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.btc-dca');
const CNY_RATE   = 7.25;

async function readJSON(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchCurrentPrice() {
  try {
    const res  = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

function fmtCNY(cny) {
  if (Math.abs(cny) >= 10000) return `${(cny / 10000).toFixed(1)} 万元`;
  return `${Math.round(cny).toLocaleString('zh-CN')} 元`;
}
function fmtPct(r, sign = true) {
  const s = (r * 100).toFixed(1) + '%';
  return sign ? (r >= 0 ? '+' : '') + s : s;
}

async function main() {
  const jsonMode = process.argv.includes('--json');

  const [strategyDoc, local, execLog] = await Promise.all([
    readJSON(join(CONFIG_DIR, 'strategy.json')),
    readJSON(join(CONFIG_DIR, 'local.json'),  {}),
    readJSON(join(CONFIG_DIR, 'execution-log.json'), { summary: {}, trades: [], skips: [] }),
  ]);

  if (!strategyDoc) {
    console.log('❌ 未找到策略配置，请先运行安装流程。');
    return;
  }

  if (!jsonMode) process.stderr.write('正在获取当前价格...\n');
  const currentPrice = await fetchCurrentPrice();

  const s        = strategyDoc.strategy ?? {};
  const budget   = local?.precise_budget ?? 0;
  const trades   = execLog.trades  ?? [];
  const skips    = execLog.skips   ?? [];
  const summary  = execLog.summary ?? {};

  // 各池总量
  const baseTotal    = budget * ((s.base_bullet_pct    ?? 15) / 100);
  const signalTotal  = budget * ((s.signal_bullet_pct  ?? 30) / 100);
  const extremeTotal = budget * ((s.extreme_bullet_pct ?? 55) / 100);

  const baseUsed    = summary.pools?.base_used            ?? 0;
  const signalUsed  = summary.pools?.signal_used          ?? 0;
  const extremeUsed = summary.pools?.extreme_used_amount  ?? 0;

  const baseRem    = Math.max(0, baseTotal    - baseUsed);
  const signalRem  = Math.max(0, signalTotal  - signalUsed);
  const extremeRem = Math.max(0, extremeTotal - extremeUsed);
  const totalRem   = baseRem + signalRem + extremeRem;

  const totalInvested = summary.total_invested_cny ?? 0;
  const totalBtc      = summary.total_btc          ?? 0;
  const avgCostUsd    = summary.avg_cost_usd        ?? 0;

  // 盈亏
  let pnlPct = null, pnlCny = null;
  if (currentPrice && avgCostUsd > 0 && totalBtc > 0) {
    pnlPct = (currentPrice - avgCostUsd) / avgCostUsd;
    pnlCny = totalBtc * (currentPrice - avgCostUsd) * CNY_RATE;
  }

  // 首次买入日 / 持续时长
  const firstDate   = trades[0]?.date ?? local?.start_date ?? null;
  let durationLabel = '-';
  if (firstDate) {
    const months = Math.round((Date.now() - new Date(firstDate).getTime()) / (86400000 * 30));
    durationLabel = months < 1 ? '不足 1 个月' : `${months} 个月`;
  }

  // 连续跳过数
  const lastTradeDate     = summary.last_trade_date ?? '2000-01-01';
  const consecutiveSkips  = skips.filter(s => s.date > lastTradeDate).length;

  if (jsonMode) {
    console.log(JSON.stringify({
      persona:          strategyDoc.persona,
      budget,
      total_invested:   totalInvested,
      total_btc:        totalBtc,
      avg_cost_usd:     avgCostUsd,
      current_price:    currentPrice,
      pnl_pct:          pnlPct,
      pnl_cny:          pnlCny,
      pools: {
        base:    { total: baseTotal,    used: baseUsed,    remaining: baseRem },
        signal:  { total: signalTotal,  used: signalUsed,  remaining: signalRem },
        extreme: { total: extremeTotal, used: extremeUsed, remaining: extremeRem,
                   triggered: summary.pools?.extreme_triggered ?? false },
      },
      trades_count:      trades.length,
      skip_count:        skips.length,
      consecutive_skips: consecutiveSkips,
      duration:          durationLabel,
    }, null, 2));
    return;
  }

  // ── 人类可读报告 ──
  const lines = [
    '【当前定投状态】',
    '',
    `已执行：${trades.length} 次  |  已投入：${fmtCNY(totalInvested)}  |  用时：${durationLabel}`,
    '',
    '持仓情况：',
    `  持有 BTC：${totalBtc.toFixed(8)} 枚`,
  ];

  if (avgCostUsd > 0)    lines.push(`  平均成本：$${Math.round(avgCostUsd).toLocaleString('en-US')}`);
  if (currentPrice)      lines.push(`  当前价格：$${Math.round(currentPrice).toLocaleString('en-US')}`);
  if (pnlPct !== null)   lines.push(`  账面盈亏：${fmtPct(pnlPct)}（约 ${pnlCny >= 0 ? '+' : ''}${fmtCNY(pnlCny)}）`);

  lines.push(
    '',
    '子弹状态：',
    `  基础池剩余：${fmtCNY(baseRem)}（已用 ${baseTotal > 0 ? fmtPct(baseUsed / baseTotal, false) : '-'}）`,
    `  信号池剩余：${fmtCNY(signalRem)}（已用 ${signalTotal > 0 ? fmtPct(signalUsed / signalTotal, false) : '-'}）`,
    `  极端池剩余：${fmtCNY(extremeRem)}（${summary.pools?.extreme_triggered ? '已触发' : '未动用'}）`,
    `  总剩余：${fmtCNY(totalRem)}`,
  );

  if (consecutiveSkips > 0) {
    lines.push('', `⚠️ 连续跳过：${consecutiveSkips} 次`);
    if (consecutiveSkips >= 3) lines.push('   建议重新评估策略是否仍适合你当前的情况。');
  }

  lines.push('', `画像：${strategyDoc.persona ?? '-'}  |  频率：${s.dca_frequency ?? '-'}`);

  console.log(lines.join('\n'));
}

main().catch(err => {
  console.error(`[analyze] ${err.message}`);
  process.exit(1);
});
