#!/usr/bin/env node
/**
 * fetch-signals.js — GitHub Actions 每日数据采集脚本（全免费数据源）
 *
 * 数据来源（均免费，无需 API Key）：
 *   CoinMetrics Community API — MVRV ratio（归一化为 MVRV-Z 近似值）
 *   alternative.me           — 恐慌贪婪指数
 *   Binance / Bybit API      — 现价 + 资金费率
 *   本地计算                  — 减半周期位置
 *
 * 更新策略：
 *   - MVRV / FGI / 资金费率 / 现价：每日自动更新
 *   - Puell Multiple / NUPL / 交易所储备：无免费 API，保留上次已知值（变化缓慢，可接受）
 *   - ETF 流向：用 FGI + 价格动量估算
 *
 * 降级策略：CoinMetrics 不可用时 → degraded:true，仅 FGI + 资金费率 + 减半周期参与计分。
 */

import { writeFile, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT    = join(__dirname, '../docs/signals-feed.json');

// ── 减半日期 ──────────────────────────────────────────────────────────────
const HALVING_DATE = new Date('2024-04-19T00:00:00Z');

// ── 归一化工具（0=低估，100=高估）─────────────────────────────────────────
function clamp01(v, lo, hi) { return Math.max(0, Math.min(1, (v - lo) / (hi - lo))); }

// MVRV ratio DCA 决策区间：~0.7（深度底部，所有持仓大幅亏损）到 ~3.5（牛市高位）
// 注：使用 DCA 相关区间而非全历史极值（历史最高 8+），避免牛顶极值把正常低估区压得过低
function normalizeMvrv(v)   { return Math.round(clamp01(v, 0.7, 3.5)  * 100); }
// Puell Multiple：~0.3（底部）到 ~4（顶部）
function normalizePuell(v)  { return Math.round(clamp01(v, 0.3, 4)    * 100); }
// NUPL：-0.3（底部）到 +0.75（顶部）
function normalizeNupl(v)   { return Math.round(clamp01(v, -0.3, 0.75)* 100); }
// 交易所储备量（BTC）：历史区间 180万–320万
// 储量低 = 牛市持仓 = 高位；储量高 = 熊市抛售 = 低位 → 方向反转
function normalizeReserves(amount) {
  if (amount == null) return 45;
  return Math.round((1 - clamp01(amount, 1_800_000, 3_200_000)) * 100);
}
// FGI：0（极恐）到 100（极贪）
function normalizeFGI(v)    { return Math.round(clamp01(v, 0, 100)    * 100); }
// 资金费率：-0.1%（做空，底部）到 +0.1%（做多，顶部）
function normalizeFunding(v){ return Math.round(clamp01(v, -0.001, 0.001) * 100); }
// 减半周期：0–48 个月，0–18 个月为底部积累窗口
function normalizeHalving(m){ return Math.round(clamp01(m, 0, 48)     * 100); }
// ETF 7日均流向：-500M（流出）到 +500M（流入）
function normalizeEtfFlow(m){ return Math.round(clamp01(m, -500, 500) * 100); }

function computeCycleScore(s) {
  return Math.round(
    s.mvrv_z            * 0.25 +
    s.puell_multiple    * 0.20 +
    s.nupl              * 0.15 +
    s.exchange_reserves * 0.10 +
    s.fgi               * 0.15 +
    s.funding_rate      * 0.05 +
    s.halving_cycle     * 0.05 +
    s.etf_flow          * 0.05,
  );
}

// ── CoinMetrics Community API（免费，无需 Key）────────────────────────────
// 返回 MVRV ratio + 交易所储备量（SplyExNtv）+ 7日前价格
async function fetchCoinMetrics() {
  const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'
    + '?assets=btc&metrics=CapMVRVCur,PriceUSD,SplyExNtv&limit_per_asset=100';

  const res = await fetch(url, {
    headers: { 'User-Agent': 'btc-dca-signals/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`CoinMetrics HTTP ${res.status}`);
  const json = await res.json();

  const rows = json?.data ?? [];
  if (!rows.length) throw new Error('CoinMetrics: empty response');

  const latest = rows[rows.length - 1];
  const mvrv   = parseFloat(latest.CapMVRVCur);
  if (isNaN(mvrv)) throw new Error('CoinMetrics: invalid MVRV value');

  const price7dAgo  = rows.length >= 8
    ? parseFloat(rows[rows.length - 8]?.PriceUSD ?? '0')
    : null;
  const reservesBtc = parseFloat(latest.SplyExNtv) || null;

  return { mvrv, price7dAgo, reservesBtc };
}

// ── 恐慌贪婪指数 ───────────────────────────────────────────────────────────
async function fetchFGI() {
  const res = await fetch('https://api.alternative.me/fng/?limit=1', {
    headers: { 'User-Agent': 'btc-dca-signals/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`FGI HTTP ${res.status}`);
  const data = await res.json();
  const entry = data.data[0];
  return { value: parseInt(entry.value, 10), label: entry.value_classification };
}

// ── Binance：现价 + 资金费率（Bybit 备用）──────────────────────────────────
async function fetchBinance() {
  const headers = { 'User-Agent': 'btc-dca-signals/1.0' };
  const [priceRes, fundingRes] = await Promise.allSettled([
    fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { headers, signal: AbortSignal.timeout(10000) }),
    fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1', { headers, signal: AbortSignal.timeout(10000) }),
  ]);

  let currentPrice = null, fundingRate = null;

  if (priceRes.status === 'fulfilled' && priceRes.value.ok) {
    currentPrice = parseFloat((await priceRes.value.json()).price);
  }
  if (fundingRes.status === 'fulfilled' && fundingRes.value.ok) {
    const arr = await fundingRes.value.json();
    if (arr?.[0]?.fundingRate != null) fundingRate = parseFloat(arr[0].fundingRate);
  }

  // Bybit 备用（资金费率）
  if (fundingRate === null) {
    try {
      const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT',
        { headers, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const d = await r.json();
        fundingRate = parseFloat(d.result.list[0].fundingRate);
      }
    } catch { /* 忽略 */ }
  }

  return { currentPrice, fundingRate };
}

// ── ETF 流向近似（FGI + 价格动量估算，无免费 API）───────────────────────────
function estimateEtfFlow(fgiVal, priceNow, price7dAgo) {
  if (!priceNow || !price7dAgo || price7dAgo === 0) return 0;
  const priceChg  = (priceNow - price7dAgo) / price7dAgo;
  const sentiment = (fgiVal - 50) / 50;              // -1 ~ +1
  return Math.round((priceChg * 0.6 + sentiment * 0.4) * 300); // 映射到 ±300M 估算
}

// ── 减半周期 ───────────────────────────────────────────────────────────────
function halvingCycleData() {
  const monthsSince = (Date.now() - HALVING_DATE.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return { months_since_halving: Math.round(monthsSince), normalized_score: normalizeHalving(monthsSince) };
}

// ── 读取旧文件（保留 Puell / NUPL / 交易所储备等慢变量）────────────────────
async function readExisting() {
  try { return JSON.parse(await readFile(OUTPUT, 'utf8')); } catch { return null; }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  const today    = new Date().toISOString().slice(0, 10);
  const existing = await readExisting();
  const halving  = halvingCycleData();

  const [mvrvResult, fgiResult, binanceResult] = await Promise.allSettled([
    fetchCoinMetrics(),
    fetchFGI(),
    fetchBinance(),
  ]);

  const mvrvData = mvrvResult.status    === 'fulfilled' ? mvrvResult.value    : null;
  const fgi      = fgiResult.status     === 'fulfilled' ? fgiResult.value     : null;
  const binance  = binanceResult.status === 'fulfilled' ? binanceResult.value : null;

  const degraded = mvrvData === null;
  let degradedReason = null;
  if (degraded) {
    const err = mvrvResult.reason?.message ?? 'unknown';
    degradedReason = `CoinMetrics 不可用（${err}），使用降级数据源`;
    console.warn('[fetch-signals] MVRV degraded:', err);
  }

  // 实时可得
  const mvrvVal  = mvrvData?.mvrv  ?? existing?.mvrv_z?.value         ?? 1.0;
  const fgiVal   = fgi?.value      ?? existing?.fgi?.value            ?? 50;
  const fgiLabel = fgi?.label      ?? existing?.fgi?.label            ?? 'Neutral';
  const fundingVal = binance?.fundingRate ?? existing?.funding_rate?.value ?? 0;
  const fundingTrend = fundingVal < -0.0001 ? 'negative' : fundingVal > 0.0001 ? 'positive' : 'neutral';
  const priceNow = binance?.currentPrice ?? existing?.current_price ?? null;

  // 交易所储备：CoinMetrics 自动获取，失败时回退到上次已知值
  const reservesBtc = mvrvData?.reservesBtc ?? existing?.exchange_reserves?.btc_amount ?? null;

  // 慢变指标：保留上次已知值（Puell / NUPL 每周手动更新）
  const puellVal          = existing?.puell_multiple?.value ?? 1.0;
  const nuplVal           = existing?.nupl?.value           ?? 0.0;
  const slowVarsUpdatedAt = existing?.slow_vars_updated_at  ?? today;

  // ETF 流向估算
  const price7dAgo = mvrvData?.price7dAgo ?? existing?.current_price ?? null;
  const etfAvg     = estimateEtfFlow(fgiVal, priceNow, price7dAgo);

  const ns = {
    mvrv_z:            normalizeMvrv(mvrvVal),
    puell_multiple:    normalizePuell(puellVal),
    nupl:              normalizeNupl(nuplVal),
    exchange_reserves: normalizeReserves(reservesBtc),
    fgi:               normalizeFGI(fgiVal),
    funding_rate:      normalizeFunding(fundingVal),
    halving_cycle:     halving.normalized_score,
    etf_flow:          normalizeEtfFlow(etfAvg),
  };

  const cycleScore = computeCycleScore(ns);

  const feed = {
    updated_at:        today,
    mvrv_z:            { value: parseFloat(mvrvVal.toFixed(4)),   normalized_score: ns.mvrv_z,             updated_at: today },
    puell_multiple:    { value: parseFloat(puellVal.toFixed(4)),  normalized_score: ns.puell_multiple,    updated_at: slowVarsUpdatedAt },
    nupl:              { value: parseFloat(nuplVal.toFixed(4)),   normalized_score: ns.nupl,               updated_at: slowVarsUpdatedAt },
    exchange_reserves: { btc_amount: reservesBtc,                  normalized_score: ns.exchange_reserves, updated_at: today },
    fgi:               { value: fgiVal, label: fgiLabel,           normalized_score: ns.fgi,               updated_at: today },
    funding_rate:      { value: parseFloat(fundingVal.toFixed(6)), trend: fundingTrend, normalized_score: ns.funding_rate, updated_at: today },
    halving_cycle:     { months_since_halving: halving.months_since_halving, normalized_score: ns.halving_cycle, updated_at: today },
    etf_flow:          { '7d_avg_usd_m': etfAvg,                  normalized_score: ns.etf_flow,          updated_at: today },
    current_price:        priceNow,
    cycle_score:          cycleScore,
    slow_vars_updated_at: slowVarsUpdatedAt,
    degraded,
    degraded_reason:      degradedReason,
  };

  await writeFile(OUTPUT, JSON.stringify(feed, null, 2), 'utf8');

  console.log(`[fetch-signals] 写入 docs/signals-feed.json`);
  console.log(`  日期：${today}  周期分：${cycleScore}${degraded ? '（降级）' : ''}`);
  console.log(`  MVRV：${mvrvVal.toFixed(3)}  Puell：${puellVal.toFixed(3)}（缓存）  NUPL：${nuplVal.toFixed(3)}（缓存）`);
  console.log(`  储备：${reservesBtc ? Math.round(reservesBtc).toLocaleString() + ' BTC' : '-（缓存）'}  FGI：${fgiVal}（${fgiLabel}）  价格：$${priceNow ?? '-'}  资金费率：${(fundingVal * 100).toFixed(4)}%`);
  if (degraded) console.warn(`  ⚠️ ${degradedReason}`);
}

main().catch(err => {
  console.error('[fetch-signals] FATAL:', err.message);
  process.exit(1);
});
