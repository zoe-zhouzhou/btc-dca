#!/usr/bin/env node
/**
 * fetch-signals.js — GitHub Actions 每日数据采集脚本
 *
 * 拉取以下数据后生成 public/signals-feed.json：
 *   - Glassnode：MVRV-Z、Puell Multiple、NUPL、交易所储备趋势
 *   - alternative.me：恐慌贪婪指数
 *   - Binance API：资金费率（Bybit 备用）、当前价格
 *   - 本地计算：减半周期位置
 *   - CryptoQuant（可选）：ETF 资金流向
 *
 * 降级策略：Glassnode 不可用时 → degraded:true，改用 FGI+资金费率+减半周期降级兜底。
 */

import { writeFile, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT    = join(__dirname, '../public/signals-feed.json');

// ── 减半日期（UTC）── 2024-04-19 为最近一次
const HALVING_DATE = new Date('2024-04-19T00:00:00Z');
const NEXT_HALVING = new Date('2028-04-20T00:00:00Z');

// ── 归一化区间（同 signals.js 逻辑） ─────────────────────────────────────

/**
 * clamp 到 [0, 100]，线性插值
 * direction: 'lower_better'（值越低分越低）或 'higher_better'（值越高分越低）
 */
function normalize(value, min, max, direction = 'lower_better') {
  const clamped = Math.max(min, Math.min(max, value));
  const raw = (clamped - min) / (max - min); // 0=min, 1=max
  return Math.round(direction === 'lower_better' ? raw * 100 : (1 - raw) * 100);
}

// MVRV-Z: 历史范围约 [-1, 10]，越低越便宜
function normalizeMvrvZ(v)       { return normalize(v, -1, 8, 'lower_better'); }
// Puell Multiple: 历史范围约 [0.3, 5]，越低越便宜
function normalizePuell(v)       { return normalize(v, 0.3, 4, 'lower_better'); }
// NUPL: [-0.3, 0.8]，越低越便宜
function normalizeNupl(v)        { return normalize(v, -0.3, 0.75, 'lower_better'); }
// 交易所储备趋势：decreasing(好) / stable / increasing(差) → 映射到 [0, 100]
function normalizeReserves(trend) {
  if (trend === 'decreasing') return 18;
  if (trend === 'stable')     return 45;
  return 72;
}
// FGI: [0, 100]，越低越恐慌（分越低）
function normalizeFGI(v)         { return normalize(v, 0, 100, 'lower_better'); }
// 资金费率：[-0.1, 0.1]，越负越便宜
function normalizeFunding(v)     { return normalize(v, -0.1, 0.1, 'lower_better'); }
// 减半周期：0个月（刚减半）到 48个月（接近下次减半），0-18个月为最优窗口
function normalizeHalvingCycle(monthsSince) {
  // 0-18 月是底部/积累期，对应低分区
  return normalize(monthsSince, 0, 48, 'lower_better');
}
// ETF 7d 平均净流向（百万美元）：-500 到 +500，流出越多越便宜
function normalizeEtfFlow(m)     { return normalize(m, -500, 500, 'lower_better'); }

// ── 周期分数加权计算 ───────────────────────────────────────────────────────
function computeCycleScore(scores) {
  const {
    mvrv_z, puell_multiple, nupl, exchange_reserves,
    fgi, funding_rate, halving_cycle, etf_flow,
  } = scores;
  return Math.round(
    mvrv_z           * 0.25 +
    puell_multiple   * 0.20 +
    nupl             * 0.15 +
    exchange_reserves * 0.10 +
    fgi              * 0.15 +
    funding_rate     * 0.05 +
    halving_cycle    * 0.05 +
    etf_flow         * 0.05,
  );
}

// ── Glassnode 数据拉取 ──────────────────────────────────────────────────────
async function fetchGlassnode() {
  const apiKey = process.env.GLASSNODE_API_KEY;
  if (!apiKey) throw new Error('GLASSNODE_API_KEY not set');

  const base = 'https://api.glassnode.com/v1/metrics';
  const common = `&a=BTC&i=24h&api_key=${apiKey}`;

  async function get(path) {
    const url = `${base}${path}?${common.slice(1)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Glassnode ${path} HTTP ${res.status}`);
    const arr = await res.json();
    if (!arr?.length) throw new Error(`Glassnode ${path} empty`);
    return arr[arr.length - 1].v; // 最新值
  }

  const [mvrvZ, puell, nupl, exchangeReserves] = await Promise.all([
    get('/market/mvrv_z_score'),
    get('/mining/puell_multiple'),
    get('/indicators/nupl'),
    get('/distribution/balance_exchanges'),
  ]);

  // 交易所储备趋势：与前7日均值比较
  const reserveHistRes = await fetch(
    `${base}/distribution/balance_exchanges?a=BTC&i=24h&api_key=${apiKey}&limit=8`,
    { signal: AbortSignal.timeout(15000) }
  );
  let reserveTrend = 'stable';
  if (reserveHistRes.ok) {
    const hist = await reserveHistRes.json();
    if (hist?.length >= 2) {
      const latest = hist[hist.length - 1].v;
      const avg7d  = hist.slice(-8, -1).reduce((s, x) => s + x.v, 0) / 7;
      if (latest < avg7d * 0.998) reserveTrend = 'decreasing';
      else if (latest > avg7d * 1.002) reserveTrend = 'increasing';
    }
  }

  return { mvrvZ, puell, nupl, exchangeReserves, reserveTrend };
}

// ── FGI 拉取 ──────────────────────────────────────────────────────────────
async function fetchFGI() {
  const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`FGI HTTP ${res.status}`);
  const data = await res.json();
  const entry = data.data[0];
  return { value: parseInt(entry.value, 10), label: entry.value_classification };
}

// ── Binance 资金费率 + 现价 ────────────────────────────────────────────────
async function fetchBinance() {
  const [priceRes, fundingRes] = await Promise.allSettled([
    fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(10000) }),
    fetch('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1', { signal: AbortSignal.timeout(10000) }),
  ]);

  let currentPrice = null, fundingRate = null;

  if (priceRes.status === 'fulfilled' && priceRes.value.ok) {
    const d = await priceRes.value.json();
    currentPrice = parseFloat(d.price);
  }
  if (fundingRes.status === 'fulfilled' && fundingRes.value.ok) {
    const d = await fundingRes.value.json();
    if (d?.[0]?.fundingRate != null) {
      fundingRate = parseFloat(d[0].fundingRate);
    }
  }

  // Bybit 备用（资金费率）
  if (fundingRate === null) {
    try {
      const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT', { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const d = await r.json();
        fundingRate = parseFloat(d.result.list[0].fundingRate);
      }
    } catch { /* 忽略 */ }
  }

  return { currentPrice, fundingRate };
}

// ── ETF 资金流（可选，从 CryptoQuant 或硬编码估算）─────────────────────────
async function fetchEtfFlow() {
  // 暂用 FGI 与资金费率联合估算 — 有 CryptoQuant API Key 时替换此逻辑
  // 返回 7 日均值（百万美元）；null 时 ETF 数据缺失，用 0 填充
  const apiKey = process.env.CRYPTOQUANT_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(
      'https://api.cryptoquant.com/v1/btc/exchange-flows/inflow?exchange=bitcoin_etf&window=day&limit=7',
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const rows = data?.result?.data ?? [];
    if (!rows.length) return null;
    const avg = rows.reduce((s, r) => s + (r.inflow_usd_million ?? 0), 0) / rows.length;
    return Math.round(avg);
  } catch {
    return null;
  }
}

// ── 减半周期 ──────────────────────────────────────────────────────────────
function halvingCycleData() {
  const now = Date.now();
  const monthsSince = (now - HALVING_DATE.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return {
    months_since_halving: Math.round(monthsSince),
    normalized_score: normalizeHalvingCycle(monthsSince),
  };
}

// ── 旧 signals-feed.json 读取（降级时保留部分字段）─────────────────────────
async function readExistingFeed() {
  try {
    return JSON.parse(await readFile(OUTPUT, 'utf8'));
  } catch {
    return null;
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  const today    = new Date().toISOString().slice(0, 10);
  const existing = await readExistingFeed();
  const halving  = halvingCycleData();

  // 并行拉取各数据源
  const [glassnodeResult, fgiResult, binanceResult, etfFlowResult] = await Promise.allSettled([
    fetchGlassnode(),
    fetchFGI(),
    fetchBinance(),
    fetchEtfFlow(),
  ]);

  const glassnode = glassnodeResult.status === 'fulfilled' ? glassnodeResult.value : null;
  const fgi       = fgiResult.status       === 'fulfilled' ? fgiResult.value       : null;
  const binance   = binanceResult.status   === 'fulfilled' ? binanceResult.value   : null;
  const etfFlow   = etfFlowResult.status   === 'fulfilled' ? etfFlowResult.value   : null;

  const degraded = glassnode === null;
  let degradedReason = null;
  if (degraded) {
    const err = glassnodeResult.reason?.message ?? 'unknown';
    degradedReason = `Glassnode 不可用（${err}），使用降级数据源`;
    console.warn('[fetch-signals] Glassnode degraded:', err);
  }

  // 资金费率
  const fundingRateVal = binance?.fundingRate ?? (existing?.funding_rate?.value ?? 0);
  const fundingTrend   = fundingRateVal < -0.005 ? 'negative' : fundingRateVal > 0.005 ? 'positive' : 'neutral';

  // FGI — 回退到旧数据
  const fgiVal   = fgi?.value ?? existing?.fgi?.value   ?? 50;
  const fgiLabel = fgi?.label ?? existing?.fgi?.label   ?? 'Neutral';

  // ETF 流向：有 API 就用，否则复用旧数据，再否则 0
  const etfAvg = etfFlow ?? existing?.etf_flow?.['7d_avg_usd_m'] ?? 0;

  // 主指标（降级时复用旧值）
  const mvrzVal  = glassnode?.mvrvZ  ?? existing?.mvrv_z?.value         ?? 0.5;
  const puellVal = glassnode?.puell  ?? existing?.puell_multiple?.value  ?? 1;
  const nuplVal  = glassnode?.nupl   ?? existing?.nupl?.value           ?? 0;
  const resTrend = glassnode?.reserveTrend ?? existing?.exchange_reserves?.trend ?? 'stable';

  // 归一化
  const normalizedScores = {
    mvrv_z:            normalizeMvrvZ(mvrzVal),
    puell_multiple:    normalizePuell(puellVal),
    nupl:              normalizeNupl(nuplVal),
    exchange_reserves: normalizeReserves(resTrend),
    fgi:               normalizeFGI(fgiVal),
    funding_rate:      normalizeFunding(fundingRateVal),
    halving_cycle:     halving.normalized_score,
    etf_flow:          normalizeEtfFlow(etfAvg),
  };

  const cycleScore = computeCycleScore(normalizedScores);

  const feed = {
    updated_at:       today,
    mvrv_z:           { value: mvrzVal,    normalized_score: normalizedScores.mvrv_z },
    puell_multiple:   { value: puellVal,   normalized_score: normalizedScores.puell_multiple },
    nupl:             { value: nuplVal,    normalized_score: normalizedScores.nupl },
    exchange_reserves: { trend: resTrend,   normalized_score: normalizedScores.exchange_reserves },
    fgi:              { value: fgiVal, label: fgiLabel, normalized_score: normalizedScores.fgi },
    funding_rate:     { value: fundingRateVal, trend: fundingTrend, normalized_score: normalizedScores.funding_rate },
    halving_cycle:    { months_since_halving: halving.months_since_halving, normalized_score: normalizedScores.halving_cycle },
    etf_flow:         { '7d_avg_usd_m': etfAvg, normalized_score: normalizedScores.etf_flow },
    current_price:    binance?.currentPrice ?? existing?.current_price ?? null,
    cycle_score:      cycleScore,
    degraded,
    degraded_reason:  degradedReason,
  };

  await writeFile(OUTPUT, JSON.stringify(feed, null, 2), 'utf8');

  console.log(`[fetch-signals] 写入 signals-feed.json`);
  console.log(`  日期：${today}`);
  console.log(`  周期分：${cycleScore}${degraded ? '（降级模式）' : ''}`);
  console.log(`  MVRV-Z：${mvrzVal}  Puell：${puellVal}  NUPL：${nuplVal}`);
  console.log(`  FGI：${fgiVal}（${fgiLabel}）`);
  console.log(`  价格：$${binance?.currentPrice ?? '-'}`);
  if (degraded) console.warn(`  ⚠️ 降级：${degradedReason}`);
}

main().catch(err => {
  console.error('[fetch-signals] FATAL:', err.message);
  process.exit(1);
});
