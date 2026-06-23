#!/usr/bin/env node
/**
 * check-triggers.js — 判断是否触发定投
 *
 * stdin:  JSON from fetch-signals.js
 * stdout: trigger decision JSON，供 deliver.js 消费
 *
 * 信号检测逻辑与 public/js/signals.js 保持一致。
 * 策略参数来自 ~/.btc-dca/strategy.json（服务端格式）。
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

// ── 信号检测（与 public/js/signals.js detectSignalLevel 逻辑一致）──────────

function computeCycleScore(feed) {
  if (typeof feed.cycle_score === 'number') return feed.cycle_score;
  const fgi = feed.fgi?.normalized_score           ?? 50;
  const fr  = feed.funding_rate?.normalized_score  ?? 50;
  const hc  = feed.halving_cycle?.normalized_score ?? 50;
  return Math.round(fgi * 0.6 + fr * 0.2 + hc * 0.2);
}

function detectSignalLevel(feed) {
  const score    = computeCycleScore(feed);
  const mvrzVal  = feed.mvrv_ratio?.value       ?? 999;
  const fgiVal   = feed.fgi?.value              ?? 50;
  const puellVal = feed.puell_multiple?.value   ?? 999;

  const scores = [
    feed.mvrv_ratio?.normalized_score         ?? 50,
    feed.puell_multiple?.normalized_score    ?? 50,
    feed.adr_act?.normalized_score           ?? 50,
    feed.exchange_reserves?.normalized_score ?? 50,
    feed.fgi?.normalized_score               ?? 50,
    feed.funding_rate?.normalized_score      ?? 50,
    feed.halving_cycle?.normalized_score     ?? 50,
    feed.ma_200d?.normalized_score           ?? 50,
  ];
  const looseCount  = scores.filter(s => s <= 40).length;
  const strictCount = scores.filter(s => s <= 25).length;

  // 极端底部 — 标准路径
  if (score <= 17 && mvrzVal < 0.85 && fgiVal < 7 && puellVal < 0.5) return 'extreme';
  // 极端底部 — ETF纪元备选
  if (score <= 15 && fgiVal < 7 && puellVal < 0.5) return 'extreme';
  // 准极端 — 标准路径
  if (score <= 22 && mvrzVal < 1.0 && fgiVal < 12) return 'quasi';
  // 准极端 — ETF纪元备选
  if (score <= 20 && fgiVal < 12) return 'quasi';
  // 加速信号
  if (score <= 30 && strictCount >= 7 && mvrzVal < 1.2 && fgiVal < 15) return 'accel';
  // 普通信号
  if (score <= 28 && looseCount >= 5 && mvrzVal < 1.5) return 'normal';
  return 'none';
}

// ── 冷静期 / 执行比例 ────────────────────────────────────────────────────

function getCooldownDays(signalLevel, s) {
  switch (signalLevel) {
    case 'normal':  return s.normal_signal_cooldown_days  ?? 7;
    case 'accel':   return s.accel_signal_cooldown_days   ?? 10;
    case 'quasi':   return s.quasi_extreme_cooldown_days  ?? 7;
    case 'extreme': return s.extreme_signal_cooldown_days ?? 7;
    default:        return 999;
  }
}

const EXEC_PCT = { normal: 0.06, accel: 0.10, quasi: 0.12, extreme: 0.20 };

function daysBetween(a, b) {
  return Math.floor(Math.abs(new Date(b) - new Date(a)) / 86400000);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── 时间触发判断 ─────────────────────────────────────────────────────────

function isTimeTriggerDay(strategy, trades) {
  const today    = todayStr();
  const freq     = strategy.dca_frequency || 'biweekly';
  const dayOfMon = new Date().getDate();

  // 避免同天重复触发
  if (trades.some(t => t.date === today && t.trigger_type === 'time_base')) return false;

  if (freq === 'weekly') {
    const lastTime = trades.filter(t => t.trigger_type === 'time_base').slice(-1)[0];
    return !lastTime || daysBetween(lastTime.date, today) >= 7;
  }
  // biweekly: 每月 1 日 和 15 日
  return dayOfMon === 1 || dayOfMon === 15;
}

// ── 信号触发冷静期检查 ───────────────────────────────────────────────────

function signalCooldownRemaining(signalLevel, strategy, trades) {
  const cooldown     = getCooldownDays(signalLevel, strategy);
  const lastSignal   = trades.filter(t => t.trigger_type?.startsWith('signal_')).slice(-1)[0];
  if (!lastSignal) return 0;
  const elapsed = daysBetween(lastSignal.date, todayStr());
  return Math.max(0, cooldown - elapsed);
}

// ── 连续跳过计数 ─────────────────────────────────────────────────────────

function consecutiveSkips(skips, trades) {
  const lastTradeDate = trades.slice(-1)[0]?.date ?? '2000-01-01';
  return skips.filter(s => s.date > lastTradeDate).length;
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  // 读 stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const signalData = JSON.parse(chunks.join(''));

  const strategyDoc = await readJSON(join(CONFIG_DIR, 'strategy.json'));
  const execLog     = await readJSON(join(CONFIG_DIR, 'execution-log.json'),
                                     { summary: {}, trades: [], skips: [] });

  if (!strategyDoc) {
    process.stdout.write(JSON.stringify({
      trigger: 'error',
      reason:  '未找到策略配置，请先运行安装流程',
    }) + '\n');
    return;
  }

  const s      = strategyDoc.strategy;     // 策略参数对象
  const trades = execLog.trades  ?? [];
  const skips  = execLog.skips   ?? [];
  const feed   = signalData.feed ?? {};
  const today  = todayStr();

  // 数据过期 → 暂停信号型触发
  if (signalData.stale) {
    process.stdout.write(JSON.stringify({
      trigger:       'stale',
      reason:        'signals-feed 数据超过 48 小时未更新，暂停信号型定投',
      cycle_score:   computeCycleScore(feed),
      signal_data:   signalData,
      strategy:      strategyDoc,
    }) + '\n');
    return;
  }

  const cycleScore      = computeCycleScore(feed);
  const entryThreshold  = strategyDoc.entry_threshold ?? 50;
  const baseBulletEntry = s.base_pool_entry_score ?? Math.min(35, entryThreshold);

  // ── 时间触发（基础池）：使用 base_pool_entry_score，比 entry_threshold 更严格 ──
  const timeTrigger = isTimeTriggerDay(s, trades) && cycleScore <= baseBulletEntry;

  // ── 信号触发：信号条件本身已要求 ≤28，entry_threshold 作为外层门槛 ──
  const signalLevel     = detectSignalLevel(feed);
  const cooldownLeft    = signalLevel !== 'none'
    ? signalCooldownRemaining(signalLevel, s, trades)
    : 0;
  const signalTrigger   = signalLevel !== 'none'
    && cycleScore <= entryThreshold
    && cooldownLeft === 0;

  // 优先级：signal > time（信号触发时已含基础池逻辑）
  let trigger = 'none';
  if (signalTrigger)     trigger = `signal_${signalLevel}`;
  else if (timeTrigger)  trigger = 'time_base';

  process.stdout.write(JSON.stringify({
    trigger,
    cycle_score:               cycleScore,
    entry_threshold:           entryThreshold,
    base_pool_entry_score:     baseBulletEntry,
    signal_level:              signalLevel,
    signal_cooldown_remaining: cooldownLeft,
    time_trigger_active:       timeTrigger,
    signal_trigger_active:     signalTrigger,
    consecutive_skips:         consecutiveSkips(skips, trades),
    exec_pct:                  EXEC_PCT[signalLevel] ?? 0,
    strategy:                  strategyDoc,
    signal_data:               signalData,
    trades_count:              trades.length,
    pool_used: {
      base:    trades.filter(t => t.pool === 'base').reduce((s, t) => s + t.amount_cny, 0),
      signal:  trades.filter(t => t.pool === 'signal').reduce((s, t) => s + t.amount_cny, 0),
      extreme: trades.filter(t => t.pool === 'extreme').reduce((s, t) => s + t.amount_cny, 0),
    },
  }) + '\n');
}

main().catch(err => {
  process.stderr.write(`[check-triggers] ${err.message}\n`);
  process.exit(1);
});
