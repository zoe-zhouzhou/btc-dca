#!/usr/bin/env node
/**
 * fetch-signals.js — GitHub Actions 每日数据采集脚本（全免费数据源）
 *
 * 数据来源（均免费，无需 API Key）：
 *   CoinMetrics Community API — MVRV Ratio（CapMVRVCur = 市值/已实现市值）
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
// Puell Multiple：对数归一化，log(0.3)→0，log(4)→100
// 原因：线性下 0.3–1.0 区间压缩过重，无法区分温和熊市与极端底部
function normalizePuell(v) {
  const lo = Math.log(0.3), hi = Math.log(4.0);
  return Math.round(clamp01(Math.log(Math.max(v, 0.01)), lo, hi) * 100);
}
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
// 资金费率：-0.05%（做空，底部）到 +0.05%（做多，顶部）
// 实际 BTC 日常区间 ±0.03%，±0.05% 足以覆盖极端；原 ±0.1% 区分度过低
function normalizeFunding(v){ return Math.round(clamp01(v, -0.0005, 0.0005) * 100); }
// 减半周期分段线性：牛顶在 ~15 个月，熊底在 ~30 个月
// 0→15月: 30→85（减半后上涨期）；15→30月: 85→10（牛顶→熊底）；30→48月: 10→45（复苏期）
function normalizeHalving(m) {
  if (m < 15) return Math.round(30 + clamp01(m, 0,  15) * 55);
  if (m < 30) return Math.round(85 - clamp01(m, 15, 30) * 75);
  return             Math.round(10 + clamp01(m, 30, 48) * 35);
}
// 200日均线乘数：price/200dMA，对数归一化
// 0.6（深跌破均线）→ 0，4.0（极端泡沫）→ 100；历史底部乘数约 0.7–0.85
function normalizeMA200(m) {
  const lo = Math.log(0.6), hi = Math.log(4.0);
  return Math.round(clamp01(Math.log(Math.max(m, 0.01)), lo, hi) * 100);
}

function computeCycleScore(s) {
  return Math.round(
    s.mvrv_ratio        * 0.20 +  // 原 0.25，200dMA 承接部分估值权重
    s.puell_multiple    * 0.20 +
    s.nupl              * 0.15 +
    s.exchange_reserves * 0.10 +
    s.fgi               * 0.15 +
    s.funding_rate      * 0.05 +
    s.halving_cycle     * 0.05 +
    s.ma_200d           * 0.10,   // 原 etf_flow 0.05，真实数据权重翻倍
  );
}

// ── CoinMetrics Community API（免费，无需 Key）────────────────────────────
// 拉取 400 天数据，同时计算 MVRV / 储备 / NUPL(精确) / Puell(价格MA近似)
async function fetchCoinMetrics() {
  const HDR = { 'User-Agent': 'btc-dca-signals/1.0' };

  // ① 基础指标（已知免费，limit=100）
  const baseUrl = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'
    + '?assets=btc&metrics=CapMVRVCur,PriceUSD,SplyExNtv&limit_per_asset=100';
  const baseRes = await fetch(baseUrl, { headers: HDR, signal: AbortSignal.timeout(20000) });
  if (!baseRes.ok) throw new Error(`CoinMetrics HTTP ${baseRes.status}`);
  const baseJson = await baseRes.json();
  const baseRows = baseJson?.data ?? [];
  if (!baseRows.length) throw new Error('CoinMetrics: empty response');

  const latest = baseRows[baseRows.length - 1];
  const mvrv   = parseFloat(latest.CapMVRVCur);
  if (isNaN(mvrv)) throw new Error('CoinMetrics: invalid MVRV value');
  const price7dAgo  = baseRows.length >= 8 ? parseFloat(baseRows[baseRows.length - 8]?.PriceUSD ?? '0') : null;
  const reservesBtc = parseFloat(latest.SplyExNtv) || null;

  // ② Puell Multiple + 200日均线（同一请求，节省 API 调用）
  let puell = null, ma200 = null;
  try {
    const start    = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const puellUrl = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'
      + `?assets=btc&metrics=IssTotUSD,PriceUSD&start_time=${start}&page_size=400`;
    const pr = await fetch(puellUrl, { headers: HDR, signal: AbortSignal.timeout(20000) });
    if (pr.ok) {
      const pRows = (await pr.json())?.data ?? [];

      // Puell Multiple
      const vals = pRows.map(r => parseFloat(r.IssTotUSD)).filter(v => !isNaN(v) && v > 0);
      const w365 = vals.slice(-365);
      if (w365.length >= 180 && vals.length > 0) {
        const ma365 = w365.reduce((s, v) => s + v, 0) / w365.length;
        puell = vals[vals.length - 1] / ma365;
      }

      // 200日均线
      const prices = pRows.map(r => parseFloat(r.PriceUSD)).filter(v => !isNaN(v) && v > 0);
      const w200   = prices.slice(-200);
      if (w200.length >= 150) {
        ma200 = w200.reduce((s, v) => s + v, 0) / w200.length;
      }
    }
  } catch { /* 忽略，保留 puell/ma200=null */ }

  // ③ NUPL = 1 - 1/MVRV（数学精确推导，非近似）
  const nupl = 1 - 1 / mvrv;

  return { mvrv, price7dAgo, reservesBtc, nupl, puell, ma200 };
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

  // OKX 备用（资金费率）
  if (fundingRate === null) {
    try {
      const r = await fetch('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP',
        { headers, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const d = await r.json();
        const rate = d.data?.[0]?.fundingRate;
        if (rate != null) fundingRate = parseFloat(rate);
      }
    } catch { /* 忽略 */ }
  }

  return { currentPrice, fundingRate };
}

// ── 减半周期 ───────────────────────────────────────────────────────────────
function halvingCycleData() {
  const monthsSince = (Date.now() - HALVING_DATE.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return { months_since_halving: Math.round(monthsSince), normalized_score: normalizeHalving(monthsSince) };
}

// ── 读取旧文件（CoinMetrics 失败时回退用）────────────────────────────────
async function readExisting() {
  try { return JSON.parse(await readFile(OUTPUT, 'utf8')); } catch { return null; }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  const now      = new Date().toISOString().slice(0, 16) + 'Z'; // 精确到分钟
  const today    = now.slice(0, 10);
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
  const mvrvVal  = mvrvData?.mvrv  ?? existing?.mvrv_ratio?.value      ?? 1.0;
  const fgiVal   = fgi?.value      ?? existing?.fgi?.value            ?? 50;
  const fgiLabel = fgi?.label      ?? existing?.fgi?.label            ?? 'Neutral';
  // live fetch → 缓存值 → 0（中性兜底），stale 标记来源
  const fundingRaw    = binance?.fundingRate ?? null;
  const fundingCached = fundingRaw === null ? (existing?.funding_rate?.value ?? null) : null;
  const fundingStale  = fundingRaw === null && fundingCached !== null;
  const fundingFailed = fundingRaw === null && fundingCached === null;
  const fundingVal    = fundingRaw ?? fundingCached ?? 0;
  const fundingTrend  = fundingFailed ? 'unknown' : fundingVal < -0.0001 ? 'negative' : fundingVal > 0.0001 ? 'positive' : 'neutral';
  const priceNow = binance?.currentPrice ?? existing?.current_price ?? null;

  // CoinMetrics 自动计算值（失败时回退到上次已知值）
  const reservesBtc = mvrvData?.reservesBtc ?? existing?.exchange_reserves?.btc_amount ?? null;
  const puellLive   = mvrvData?.puell       ?? null;
  const nuplLive    = mvrvData?.nupl        ?? null;
  const ma200Live   = mvrvData?.ma200       ?? null;

  const puellVal = puellLive ?? existing?.puell_multiple?.value ?? 1.0;
  const nuplVal  = nuplLive  ?? existing?.nupl?.value          ?? 0.0;

  const slowVarsUpdatedAt = existing?.slow_vars_updated_at ?? today;

  // 200日均线乘数（price / MA200）；失败时用缓存，无缓存则 null（归一化用 1.0 中性）
  const ma200Val   = ma200Live ?? existing?.ma_200d?.ma_value ?? null;
  const ma200Mult  = (ma200Val && priceNow) ? priceNow / ma200Val : null;

  const ns = {
    mvrv_ratio:        normalizeMvrv(mvrvVal),
    puell_multiple:    normalizePuell(puellVal),
    nupl:              normalizeNupl(nuplVal),
    exchange_reserves: normalizeReserves(reservesBtc),
    fgi:               normalizeFGI(fgiVal),
    funding_rate:      normalizeFunding(fundingVal),
    halving_cycle:     halving.normalized_score,
    ma_200d:           normalizeMA200(ma200Mult ?? 1.0),
  };

  const cycleScore = computeCycleScore(ns);

  const feed = {
    updated_at:        now,
    mvrv_ratio:        { value: parseFloat(mvrvVal.toFixed(4)),   normalized_score: ns.mvrv_ratio,         updated_at: today },
    puell_multiple:    { value: parseFloat(puellVal.toFixed(4)),  normalized_score: ns.puell_multiple,    updated_at: puellLive  != null ? today : slowVarsUpdatedAt },
    nupl:              { value: parseFloat(nuplVal.toFixed(4)),   normalized_score: ns.nupl,               updated_at: nuplLive   != null ? today : slowVarsUpdatedAt },
    exchange_reserves: { btc_amount: reservesBtc,                  normalized_score: ns.exchange_reserves, updated_at: today },
    fgi:               { value: fgiVal, label: fgiLabel,           normalized_score: ns.fgi,               updated_at: today },
    funding_rate:      { value: fundingFailed ? null : parseFloat(fundingVal.toFixed(6)), trend: fundingTrend, stale: fundingStale, normalized_score: ns.funding_rate, updated_at: today },
    halving_cycle:     { months_since_halving: halving.months_since_halving, normalized_score: ns.halving_cycle, updated_at: today },
    ma_200d:           { multiplier: ma200Mult ? parseFloat(ma200Mult.toFixed(3)) : null, ma_value: ma200Val ? Math.round(ma200Val) : null, normalized_score: ns.ma_200d, updated_at: today },
    current_price: priceNow,
    cycle_score:   cycleScore,
    degraded,
    degraded_reason:      degradedReason,
  };

  await writeFile(OUTPUT, JSON.stringify(feed, null, 2), 'utf8');

  console.log(`[fetch-signals] 写入 docs/signals-feed.json`);
  console.log(`  日期：${today}  周期分：${cycleScore}${degraded ? '（降级）' : ''}`);
  const puellSrc = puellLive != null ? '自动' : '缓存';
  const nuplSrc  = nuplLive  != null ? '精确' : (mvrvData ? 'MVRV近似' : '缓存');
  console.log(`  MVRV：${mvrvVal.toFixed(3)}  Puell：${puellVal.toFixed(3)}（${puellSrc}）  NUPL：${nuplVal.toFixed(3)}（${nuplSrc}）`);
  const fundingStr = fundingFailed ? '获取失败（中性50）' : `${(fundingVal * 100).toFixed(4)}%${fundingStale ? '（缓存）' : ''}`;
  const ma200Str   = ma200Mult ? `×${ma200Mult.toFixed(3)}（MA=$${Math.round(ma200Val).toLocaleString()}）` : '无数据（中性）';
  console.log(`  储备：${reservesBtc ? Math.round(reservesBtc).toLocaleString() + ' BTC' : '-（缓存）'}  FGI：${fgiVal}（${fgiLabel}）  价格：$${priceNow ?? '-'}  资金费率：${fundingStr}`);
  console.log(`  200dMA乘数：${ma200Str}`);
  if (degraded) console.warn(`  ⚠️ ${degradedReason}`);
}

main().catch(err => {
  console.error('[fetch-signals] FATAL:', err.message);
  process.exit(1);
});
