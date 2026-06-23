#!/usr/bin/env node
/**
 * fetch-signals.js — 拉取市场信号数据，输出 JSON 到 stdout
 *
 * 数据来源：
 *   - signals-feed.json（GitHub Pages，每日更新）
 *   - Binance API（现价 + 7d/30d 涨跌幅 + 200周均线）
 *   - alternative.me（恐慌贪婪指数，与 signals-feed 互为校验）
 *
 * 输出到 stdout 供 check-triggers.js 消费。
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.btc-dca');
const FEED_URL_DEFAULT = 'https://zoe-zhouzhou.github.io/btc-dca/signals-feed.json';

async function readConfig() {
  try {
    const raw = await readFile(join(CONFIG_DIR, 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function fetchSignalsFeed(url) {
  const res = await fetch(url + '?t=' + Date.now(), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchCurrentPrice() {
  const sources = [
    async () => {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`Binance ${r.status}`);
      return parseFloat((await r.json()).price);
    },
    async () => {
      const r = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`Coinbase ${r.status}`);
      return parseFloat((await r.json()).data.amount);
    },
    async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
      return (await r.json()).bitcoin.usd;
    },
  ];
  for (const fn of sources) {
    try { const p = await fn(); if (p > 0) return p; } catch { /* 尝试下一个 */ }
  }
  throw new Error('all price sources failed');
}

async function fetchBinanceData() {
  // 当前价格（多源兜底）
  const currentPrice = await fetchCurrentPrice();

  // 日线 K 线：7天 + 30天
  const [klines7d, klines30d] = await Promise.all([
    fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=8', { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
    fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=31', { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
  ]);

  const price7dAgo  = parseFloat(klines7d[0][1]);
  const price30dAgo = parseFloat(klines30d[0][1]);
  const change7d    = (currentPrice - price7dAgo)  / price7dAgo;
  const change30d   = (currentPrice - price30dAgo) / price30dAgo;

  // 200 周均线（周线 K 线最近 200 根的收盘价均值）
  let ma200w = null;
  try {
    const weeklyKlines = await fetch(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=200',
      { signal: AbortSignal.timeout(10000) }
    ).then(r => r.json());
    const closes = weeklyKlines.map(k => parseFloat(k[4]));
    ma200w = closes.reduce((sum, p) => sum + p, 0) / closes.length;
  } catch {
    // 200周均线不影响主逻辑，失败时忽略
  }

  return { currentPrice, change7d, change30d, ma200w };
}

async function fetchFGI() {
  const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`FGI HTTP ${res.status}`);
  const data = await res.json();
  const entry = data.data[0];
  return { value: parseInt(entry.value, 10), label: entry.value_classification };
}

function checkStaleness(feed) {
  if (!feed?.updated_at) return { stale: true, hoursOld: null };
  const updatedAt = new Date(feed.updated_at);
  const hoursOld  = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
  return { stale: hoursOld > 48, hoursOld: Math.round(hoursOld) };
}

async function main() {
  const config  = await readConfig();
  const feedUrl = config.signals_feed_url || FEED_URL_DEFAULT;

  const [feedResult, binanceResult, fgiResult] = await Promise.allSettled([
    fetchSignalsFeed(feedUrl),
    fetchBinanceData(),
    fetchFGI(),
  ]);

  const errors = [];
  const feed    = feedResult.status === 'fulfilled'   ? feedResult.value   : null;
  const binance = binanceResult.status === 'fulfilled' ? binanceResult.value : null;
  const fgi     = fgiResult.status === 'fulfilled'    ? fgiResult.value    : null;

  if (feedResult.status === 'rejected')    errors.push(`signals-feed: ${feedResult.reason.message}`);
  if (binanceResult.status === 'rejected') errors.push(`binance: ${binanceResult.reason.message}`);
  if (fgiResult.status === 'rejected')     errors.push(`fgi: ${fgiResult.reason.message}`);

  const { stale, hoursOld } = checkStaleness(feed);
  if (stale) errors.push(`signals-feed 已超过 ${hoursOld ?? '?'} 小时未更新`);

  process.stdout.write(JSON.stringify({
    fetched_at: new Date().toISOString(),
    feed,
    binance,
    fgi,
    stale,
    errors,
  }) + '\n');
}

main().catch(err => {
  process.stderr.write(`[fetch-signals] ${err.message}\n`);
  process.exit(1);
});
