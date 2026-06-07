#!/usr/bin/env node
/**
 * log-trade.js — 记录一笔买入
 *
 * 用法（CLI）：
 *   node scripts/log-trade.js <amount_cny> <price_usd> <trigger_type> <pool> [note]
 *
 * 用法（stdin JSON）：
 *   echo '{"amount_cny":77000,"price_usd":66200,"trigger_type":"time_base","pool":"base"}' \
 *     | node scripts/log-trade.js
 *
 * trigger_type: time_base | signal_normal | signal_accel | signal_quasi | signal_extreme | manual
 * pool:         base | signal | extreme
 *
 * 使用近似汇率 7.25 CNY/USD 估算 BTC 数量（仅供记录，不作财务依据）。
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.btc-dca');
const LOG_FILE   = join(CONFIG_DIR, 'execution-log.json');
const CNY_RATE   = 7.25;

async function readLog() {
  try {
    return JSON.parse(await readFile(LOG_FILE, 'utf8'));
  } catch {
    return {
      summary: {
        total_invested_cny:   0,
        total_btc:            0,
        avg_cost_usd:         0,
        pools:                { base_used: 0, signal_used: 0, extreme_used_amount: 0, extreme_triggered: false },
        skip_count:           0,
        drawdown_alerts_sent: [],
        last_trade_date:      null,
      },
      trades: [],
      skips:  [],
    };
  }
}

async function writeLog(log) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

function recomputeSummary(log) {
  const trades = log.trades;
  const totalInvested = trades.reduce((s, t) => s + (t.amount_cny ?? 0), 0);
  const totalBtc      = trades.reduce((s, t) => s + (t.btc_amount ?? 0), 0);
  const avgCostUsd    = totalBtc > 0 ? (totalInvested / CNY_RATE) / totalBtc : 0;

  log.summary = {
    ...log.summary,
    total_invested_cny: Math.round(totalInvested),
    total_btc:          parseFloat(totalBtc.toFixed(8)),
    avg_cost_usd:       parseFloat(avgCostUsd.toFixed(2)),
    pools: {
      base_used:            trades.filter(t => t.pool === 'base').reduce((s, t) => s + t.amount_cny, 0),
      signal_used:          trades.filter(t => t.pool === 'signal').reduce((s, t) => s + t.amount_cny, 0),
      extreme_used_amount:  trades.filter(t => t.pool === 'extreme').reduce((s, t) => s + t.amount_cny, 0),
      extreme_triggered:    trades.some(t => t.pool === 'extreme'),
    },
    last_trade_date:      trades.slice(-1)[0]?.date ?? null,
    skip_count:           log.skips?.length ?? 0,
    drawdown_alerts_sent: log.summary?.drawdown_alerts_sent ?? [],
  };
}

async function readStdinJSON() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = chunks.join('').trim();
  return text ? JSON.parse(text) : null;
}

async function main() {
  let trade;

  if (process.argv.length >= 6) {
    const [,, amount_cny, price_usd, trigger_type, pool, ...rest] = process.argv;
    trade = {
      amount_cny:   parseFloat(amount_cny),
      price_usd:    parseFloat(price_usd),
      trigger_type: trigger_type,
      pool:         pool,
      note:         rest.join(' '),
    };
  } else {
    trade = await readStdinJSON();
    if (!trade) {
      console.error('用法：node log-trade.js <amount_cny> <price_usd> <trigger_type> <pool> [note]');
      process.exit(1);
    }
  }

  if (!trade.amount_cny || isNaN(trade.amount_cny)) { console.error('错误：amount_cny 必填且为数字'); process.exit(1); }
  if (!trade.price_usd  || isNaN(trade.price_usd))  { console.error('错误：price_usd 必填且为数字');  process.exit(1); }

  const log   = await readLog();
  const today = new Date().toISOString().slice(0, 10);
  const btcAmt = trade.amount_cny / (trade.price_usd * CNY_RATE);

  const entry = {
    id:           `trade_${String(log.trades.length + 1).padStart(3, '0')}`,
    date:         today,
    amount_cny:   Math.round(trade.amount_cny),
    price_usd:    trade.price_usd,
    btc_amount:   parseFloat(btcAmt.toFixed(8)),
    trigger_type: trade.trigger_type ?? 'manual',
    pool:         trade.pool ?? 'base',
    note:         trade.note ?? '',
  };

  log.trades.push(entry);
  recomputeSummary(log);
  await writeLog(log);

  console.log(`\n✓ 已记录`);
  console.log(`  ID：${entry.id}`);
  console.log(`  日期：${entry.date}`);
  console.log(`  触发：${entry.trigger_type} / ${entry.pool}池`);
  console.log(`  金额：¥${entry.amount_cny.toLocaleString('zh-CN')}`);
  console.log(`  价格：$${entry.price_usd.toLocaleString('en-US')}`);
  console.log(`  BTC：${entry.btc_amount}`);
  console.log(`  累计投入：¥${log.summary.total_invested_cny.toLocaleString('zh-CN')}`);
}

main().catch(err => {
  console.error(`[log-trade] ${err.message}`);
  process.exit(1);
});
