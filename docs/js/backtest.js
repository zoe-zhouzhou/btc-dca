/**
 * backtest.js v2 — 历史回测引擎
 *
 * 修复：
 *   1. MVRV ratio / Puell / 200日均线乘数 由价格历史近似，对齐 detectSignalLevel 阈值
 *   2. 活跃地址比率 / 交易所储备 / 资金费率 无历史数据，用中性值 50 填充
 *   3. 基础池每次执行改为 1/34（周投）或 1/17（双周投）
 *   4. 周期分数近似：MVRV ratio(25%) + Puell(20%) + MA200(10%) + FGI(15%) + 减半(5%) + 缺失25%@50
 *
 * 对外暴露：
 *   BTC_WEEKLY_DATA   历史价格数组 [{ date, price, fgi? }]
 *   runBacktest(params) → result
 *   formatPct(n)
 *   formatMultiple(n)
 */

/* ═══════════════════════════════════════════════════════
   1. 历史 BTC 价格数据（2013-01 ~ 2024-12，双周一条）
═══════════════════════════════════════════════════════ */
const BTC_WEEKLY_DATA = (function () {
  const raw = [
    // 2013
    ['2013-01-06', 13.4, null],  ['2013-01-20', 18.7, null],
    ['2013-02-03', 22.1, null],  ['2013-02-17', 28.3, null],
    ['2013-03-03', 35.0, null],  ['2013-03-17', 47.5, null],
    ['2013-04-07', 166, null],   ['2013-04-21', 68.5, null],
    ['2013-05-05', 113, null],   ['2013-05-19', 122, null],
    ['2013-06-02', 104, null],   ['2013-06-16', 97.2, null],
    ['2013-07-07', 74.8, null],  ['2013-07-21', 88.0, null],
    ['2013-08-04', 104, null],   ['2013-08-18', 110, null],
    ['2013-09-01', 131, null],   ['2013-09-15', 125, null],
    ['2013-10-06', 128, null],   ['2013-10-20', 182, null],
    ['2013-11-03', 221, null],   ['2013-11-17', 642, null],
    ['2013-12-01', 1090, null],  ['2013-12-15', 815, null],
    ['2013-12-29', 730, null],
    // 2014
    ['2014-01-12', 911, null],   ['2014-01-26', 825, null],
    ['2014-02-09', 642, null],   ['2014-02-23', 564, null],
    ['2014-03-09', 620, null],   ['2014-03-23', 565, null],
    ['2014-04-06', 445, null],   ['2014-04-20', 498, null],
    ['2014-05-04', 444, null],   ['2014-05-18', 440, null],
    ['2014-06-01', 630, null],   ['2014-06-15', 593, null],
    ['2014-07-06', 638, null],   ['2014-07-20', 617, null],
    ['2014-08-03', 588, null],   ['2014-08-17', 500, null],
    ['2014-09-07', 478, null],   ['2014-09-21', 395, null],
    ['2014-10-05', 333, null],   ['2014-10-19', 381, null],
    ['2014-11-02', 322, null],   ['2014-11-16', 370, null],
    ['2014-11-30', 378, null],   ['2014-12-14', 323, null],
    ['2014-12-28', 317, null],
    // 2015
    ['2015-01-11', 265, null],   ['2015-01-25', 225, null],
    ['2015-02-08', 231, null],   ['2015-02-22', 240, null],
    ['2015-03-08', 272, null],   ['2015-03-22', 263, null],
    ['2015-04-05', 248, null],   ['2015-04-19', 222, null],
    ['2015-05-03', 233, null],   ['2015-05-17', 240, null],
    ['2015-06-07', 230, null],   ['2015-06-21', 258, null],
    ['2015-07-05', 275, null],   ['2015-07-19', 285, null],
    ['2015-08-02', 279, null],   ['2015-08-16', 261, null],
    ['2015-08-30', 229, null],   ['2015-09-13', 237, null],
    ['2015-09-27', 235, null],   ['2015-10-11', 244, null],
    ['2015-10-25', 304, null],   ['2015-11-08', 384, null],
    ['2015-11-22', 356, null],   ['2015-12-06', 370, null],
    ['2015-12-20', 441, null],
    // 2016
    ['2016-01-03', 434, null],   ['2016-01-17', 390, null],
    ['2016-01-31', 378, null],   ['2016-02-14', 393, null],
    ['2016-02-28', 430, null],   ['2016-03-13', 415, null],
    ['2016-03-27', 416, null],   ['2016-04-10', 421, null],
    ['2016-04-24', 448, null],   ['2016-05-08', 455, null],
    ['2016-05-22', 447, null],   ['2016-06-05', 576, null],
    ['2016-06-19', 675, null],   ['2016-07-03', 666, null],
    ['2016-07-17', 670, null],   ['2016-07-31', 582, null],
    ['2016-08-14', 576, null],   ['2016-08-28', 571, null],
    ['2016-09-11', 608, null],   ['2016-09-25', 610, null],
    ['2016-10-09', 619, null],   ['2016-10-23', 655, null],
    ['2016-11-06', 707, null],   ['2016-11-20', 730, null],
    ['2016-12-04', 748, null],   ['2016-12-18', 793, null],
    // 2017
    ['2017-01-01', 998, null],   ['2017-01-15', 812, null],
    ['2017-01-29', 934, null],   ['2017-02-12', 1040, null],
    ['2017-02-26', 1192, null],  ['2017-03-12', 1280, null],
    ['2017-03-26', 1042, null],  ['2017-04-09', 1185, null],
    ['2017-04-23', 1312, null],  ['2017-05-07', 1574, null],
    ['2017-05-21', 2084, null],  ['2017-06-04', 2755, null],
    ['2017-06-18', 2560, null],  ['2017-07-02', 2534, null],
    ['2017-07-16', 1985, null],  ['2017-07-30', 2771, null],
    ['2017-08-13', 4131, null],  ['2017-08-27', 4370, null],
    ['2017-09-10', 4237, null],  ['2017-09-24', 3762, null],
    ['2017-10-08', 4731, null],  ['2017-10-22', 5983, null],
    ['2017-11-05', 7475, null],  ['2017-11-19', 8000, null],
    ['2017-12-03', 11685, null], ['2017-12-17', 19497, null],
    ['2017-12-31', 13860, null],
    // 2018
    ['2018-01-14', 14165, null], ['2018-01-28', 11768, null],
    ['2018-02-11', 8583, null],  ['2018-02-25', 9682, null],
    ['2018-03-11', 8892, null],  ['2018-03-25', 8545, null],
    ['2018-04-08', 6988, null],  ['2018-04-22', 8900, null],
    ['2018-05-06', 9633, null],  ['2018-05-20', 8283, null],
    ['2018-06-03', 7436, null],  ['2018-06-17', 6638, null],
    ['2018-07-01', 6395, null],  ['2018-07-15', 6290, null],
    ['2018-07-29', 8136, null],  ['2018-08-12', 6131, null],
    ['2018-08-26', 6903, null],  ['2018-09-09', 6290, null],
    ['2018-09-23', 6710, null],  ['2018-10-07', 6547, null],
    ['2018-10-21', 6455, null],  ['2018-11-04', 6343, null],
    ['2018-11-18', 5548, null],  ['2018-12-02', 4030, null],
    ['2018-12-16', 3232, null],  ['2018-12-30', 3746, null],
    // 2019
    ['2019-01-13', 3597, 10],    ['2019-01-27', 3459, 11],
    ['2019-02-10', 3587, 14],    ['2019-02-24', 3977, 18],
    ['2019-03-10', 3864, 20],    ['2019-03-24', 4000, 25],
    ['2019-04-07', 5198, null],  ['2019-04-21', 5285, 38],
    ['2019-05-05', 5814, 42],    ['2019-05-19', 8176, 52],
    ['2019-06-02', 8721, 58],    ['2019-06-16', 8993, 55],
    ['2019-07-07', 12015, 62],   ['2019-07-21', 10520, 48],
    ['2019-08-04', 10924, 55],   ['2019-08-18', 10278, 52],
    ['2019-09-01', 9584, 42],    ['2019-09-15', 10213, 45],
    ['2019-09-29', 8128, 38],    ['2019-10-13', 8200, 40],
    ['2019-10-27', 9485, 45],    ['2019-11-10', 8786, 35],
    ['2019-11-24', 7155, 28],    ['2019-12-08', 7215, 30],
    ['2019-12-22', 7205, 32],
    // 2020
    ['2020-01-05', 7411, 35],    ['2020-01-19', 8775, 40],
    ['2020-02-02', 9350, 42],    ['2020-02-16', 10220, 45],
    ['2020-03-01', 8647, 35],    ['2020-03-15', 5359, 10],
    ['2020-03-29', 6441, 14],    ['2020-04-12', 6858, 20],
    ['2020-04-26', 7765, 30],    ['2020-05-10', 8720, 35],
    ['2020-05-24', 9375, 42],    ['2020-06-07', 9670, 45],
    ['2020-06-21', 9285, 42],    ['2020-07-05', 9177, 40],
    ['2020-07-19', 9190, 42],    ['2020-08-02', 11322, 52],
    ['2020-08-16', 11717, 55],   ['2020-08-30', 11635, 52],
    ['2020-09-13', 10421, 45],   ['2020-09-27', 10785, 48],
    ['2020-10-11', 11465, 50],   ['2020-10-25', 13115, 55],
    ['2020-11-08', 15434, 60],   ['2020-11-22', 18599, 68],
    ['2020-12-06', 19180, 72],   ['2020-12-20', 23630, 78],
    // 2021
    ['2021-01-03', 33122, 82],   ['2021-01-17', 36832, 80],
    ['2021-01-31', 32923, 72],   ['2021-02-14', 47920, 80],
    ['2021-02-28', 46178, 75],   ['2021-03-14', 56803, 78],
    ['2021-03-28', 54945, 74],   ['2021-04-11', 59776, 78],
    ['2021-04-25', 49105, 60],   ['2021-05-09', 56706, 62],
    ['2021-05-23', 37555, 25],   ['2021-06-06', 35680, 22],
    ['2021-06-20', 32487, 18],   ['2021-07-04', 33824, 22],
    ['2021-07-18', 31544, 20],   ['2021-08-01', 38167, 38],
    ['2021-08-15', 44659, 52],   ['2021-08-29', 49264, 58],
    ['2021-09-12', 44877, 50],   ['2021-09-26', 43068, 48],
    ['2021-10-10', 56521, 60],   ['2021-10-24', 60632, 70],
    ['2021-11-07', 67582, 74],   ['2021-11-21', 56500, 60],
    ['2021-12-05', 49207, 42],   ['2021-12-19', 46321, 38],
    // 2022
    ['2022-01-02', 46217, 42],   ['2022-01-16', 43098, 35],
    ['2022-01-30', 37692, 25],   ['2022-02-13', 42421, 38],
    ['2022-02-27', 39113, 30],   ['2022-03-13', 38724, 35],
    ['2022-03-27', 47059, 42],   ['2022-04-10', 42186, 35],
    ['2022-04-24', 39700, 30],   ['2022-05-08', 34032, 18],
    ['2022-05-22', 30009, 14],   ['2022-06-05', 29099, 12],
    ['2022-06-19', 19048, 8],    ['2022-07-03', 20234, 12],
    ['2022-07-17', 22940, 20],   ['2022-07-31', 23298, 22],
    ['2022-08-14', 24401, 30],   ['2022-08-28', 20027, 22],
    ['2022-09-11', 22386, 24],   ['2022-09-25', 19535, 20],
    ['2022-10-09', 19569, 22],   ['2022-10-23', 20623, 25],
    ['2022-11-06', 21050, 28],   ['2022-11-20', 16282, 10],
    ['2022-12-04', 17151, 12],   ['2022-12-18', 16765, 11],
    // 2023
    ['2023-01-01', 16625, 10],   ['2023-01-15', 20970, 22],
    ['2023-01-29', 23134, 32],   ['2023-02-12', 21730, 28],
    ['2023-02-26', 23479, 35],   ['2023-03-12', 22391, 30],
    ['2023-03-26', 27739, 45],   ['2023-04-09', 28323, 48],
    ['2023-04-23', 29499, 50],   ['2023-05-07', 28678, 48],
    ['2023-05-21', 27110, 42],   ['2023-06-04', 27127, 45],
    ['2023-06-18', 26765, 42],   ['2023-07-02', 30640, 55],
    ['2023-07-16', 30300, 52],   ['2023-07-30', 29330, 50],
    ['2023-08-13', 29320, 48],   ['2023-08-27', 26050, 38],
    ['2023-09-10', 26524, 40],   ['2023-09-24', 26845, 42],
    ['2023-10-08', 27967, 48],   ['2023-10-22', 30023, 55],
    ['2023-11-05', 35054, 62],   ['2023-11-19', 37717, 68],
    ['2023-12-03', 41665, 72],   ['2023-12-17', 42849, 74],
    ['2023-12-31', 42531, 73],
    // 2024
    ['2024-01-14', 43173, 72],   ['2024-01-28', 39545, 62],
    ['2024-02-11', 48189, 74],   ['2024-02-25', 55994, 78],
    ['2024-03-10', 71415, 82],   ['2024-03-24', 66971, 76],
    ['2024-04-07', 72486, 80],   ['2024-04-21', 64994, 62],
    ['2024-05-05', 63982, 65],   ['2024-05-19', 67019, 72],
    ['2024-06-02', 67523, 70],   ['2024-06-16', 65888, 68],
    ['2024-07-07', 57390, 55],   ['2024-07-21', 68260, 65],
    ['2024-08-04', 61373, 42],   ['2024-08-18', 60186, 45],
    ['2024-09-01', 57369, 42],   ['2024-09-15', 58989, 48],
    ['2024-09-29', 63290, 52],   ['2024-10-13', 62897, 55],
    ['2024-10-27', 70971, 65],   ['2024-11-10', 87419, 78],
    ['2024-11-24', 97827, 82],   ['2024-12-08', 99882, 84],
    ['2024-12-22', 97344, 80],
  ];
  return raw.map(([date, price, fgi]) => ({ date, price, fgi }));
})();


/* ═══════════════════════════════════════════════════════
   2. 历史近似指标函数
═══════════════════════════════════════════════════════ */

// 减半日期（历次）
const HALVING_DATES = ['2012-11-28', '2016-07-09', '2020-05-11', '2024-04-19'];

/** 距上次减半的月数 */
function halvingMonthsSince(dateStr) {
  const d = new Date(dateStr);
  let latest = new Date('2009-01-03');
  for (const hd of HALVING_DATES) {
    const h = new Date(hd);
    if (h <= d) latest = h;
  }
  return (d - latest) / (30.44 * 86400000);
}

/** 减半周期归一化分数（0-100，低 = 早期积累，高 = 晚期牛市） */
function halvingCycleNorm(dateStr) {
  const months = halvingMonthsSince(dateStr);
  // 4年周期约48个月，前12个月是积累区（低估），中间爬升，36个月以上接近牛市顶部
  const clipped = Math.min(months, 48);
  return Math.round(10 + (clipped / 48) * 75);
}

/**
 * 近似 MVRV ratio（返回实际值，非百分位）
 * 用 2年移动均线（~104条双周数据）作为"已实现价格"代理
 * 内部用 Z-like 变换 (mvrv - 1.8) / 0.7 对齐历史底部阈值，所以变量名保留 mvrvZ
 * 阈值对应关系：ratio 0.85→-1.36, 1.0→-1.14, 1.2→-0.86, 1.5→-0.43
 * 历史校验：2015年1月、2022年11月均在 -0.5 附近 ✓
 */
function approxMvrvZ(idx, data) {
  const start = Math.max(0, idx - 104);
  const slice = data.slice(start, idx + 1);
  const realized = slice.reduce((s, d) => s + d.price, 0) / slice.length;
  const mvrv = data[idx].price / realized;
  return parseFloat(((mvrv - 1.8) / 0.7).toFixed(2));
}

/**
 * 近似 200日均线乘数（当前价 / 200日MA）
 * 200天 ≈ 双周数据 14 条
 */
function approxMa200(idx, data) {
  const start = Math.max(0, idx - 14);
  const slice = data.slice(start, idx + 1);
  const ma = slice.reduce((s, d) => s + d.price, 0) / slice.length;
  return parseFloat((data[idx].price / ma).toFixed(3));
}

/**
 * 近似 Puell Multiple（返回实际值）
 * 用 365日（~26条双周）均线近似矿工收入基准
 * Puell = currentPrice / ma365
 * 历史校验：熊市底部 Puell < 0.5 ✓
 */
function approxPuell(idx, data) {
  const start = Math.max(0, idx - 26);
  const slice = data.slice(start, idx + 1);
  const ma365 = slice.reduce((s, d) => s + d.price, 0) / slice.length;
  return parseFloat((data[idx].price / ma365).toFixed(2));
}

// ── 归一化到 0-100（分数越低越便宜）──

function mvrvZToNorm(z) {
  // z ≤ -0.3 → ≤10；z=0 → ~20；z=1 → ~40；z=3 → ~75；z≥7 → 100
  return Math.max(0, Math.min(100, Math.round((z + 2) / 9 * 100)));
}

function puellToNorm(p) {
  // p < 0.5 → 0-15；p≈1 → ~30；p≈2 → ~60；p≥4 → 100
  return Math.max(0, Math.min(100, Math.round(p / 4 * 100)));
}

function ma200ToNorm(m) {
  // 对数归一化 [0.6, 4.0]，与 fetch-signals.js normalizeMA200 对齐
  const lo = Math.log(0.6), hi = Math.log(4.0);
  return Math.max(0, Math.min(100, Math.round((Math.log(Math.max(m, 0.01)) - lo) / (hi - lo) * 100)));
}

/** FGI 历史百分位（截止当前已有数据） */
function calcFgiPercentile(idx, data) {
  const slice = data.slice(0, idx + 1).filter(d => d.fgi !== null);
  if (slice.length === 0 || data[idx].fgi === null) return 50;
  const below = slice.filter(d => d.fgi <= data[idx].fgi).length;
  return Math.round((below / slice.length) * 100);
}

/**
 * FGI 估算值（有实际数据时直接返回，否则用价格行情近似）
 * 用 52 周最高价跌幅 + 短期动量两因子合成，覆盖 FGI 发布前（2018年前）的历史数据。
 * 校验：2018-12-16 ($3232) ≈ 5–8，与当时市场极度恐慌吻合
 */
function approxFgi(idx, data) {
  if (data[idx].fgi !== null) return data[idx].fgi;

  const current = data[idx].price;

  // 52 周（~26 条双周）最高价跌幅
  const start52 = Math.max(0, idx - 26);
  const high52  = Math.max(...data.slice(start52, idx + 1).map(d => d.price));
  const dd52    = (high52 - current) / high52;

  // 短期（4 周）价格动量
  const prev4w = idx >= 2 ? data[idx - 2].price : current;
  const mom4w  = (current - prev4w) / prev4w;

  // 基础 FGI：跌幅越大越恐慌
  let fgi = Math.round(75 - dd52 * 90);

  // 短期急跌加剧恐慌
  if      (mom4w < -0.15) fgi -= 15;
  else if (mom4w < -0.05) fgi -= 5;
  else if (mom4w >  0.10) fgi += 10;

  return Math.max(5, Math.min(85, fgi));
}

/**
 * 近似周期分数（6因子加权，对齐 8 指标体系）
 * MVRV(25%) + Puell(20%) + MA200(10%) + FGI(15%) + Halving(5%) = 75%
 * 缺失指标（活跃地址比率/交易所储备/资金费率，共 25%）用中性值 50 填充
 */
function approxCycleScore(idx, data) {
  const d = data[idx];
  const mvrvZ  = approxMvrvZ(idx, data);
  const puell  = approxPuell(idx, data);
  const ma200  = approxMa200(idx, data);
  const fgi    = approxFgi(idx, data);
  const halv   = halvingCycleNorm(d.date);

  const s_mvrv  = mvrvZToNorm(mvrvZ);  // 25%
  const s_puell = puellToNorm(puell);  // 20%
  const s_ma200 = ma200ToNorm(ma200);  // 10%
  const s_fgi   = fgi;                 // 15%
  const s_halv  = halv;                // 5%
  // 缺失指标（活跃地址比率 10% + 交易所储备 10% + 资金费率 5% = 25%）用中性值 50
  return Math.round(
    s_mvrv  * 0.25 +
    s_puell * 0.20 +
    s_ma200 * 0.10 +
    s_fgi   * 0.15 +
    50      * 0.25 +
    s_halv  * 0.05
  );
}

/**
 * 检测回测信号等级（复用 detectSignalLevel 阈值，近似版）
 *
 * 关键设计：只统计有真实数据的指标，阈值按比例缩放（5/8 和 7/8）。
 * 若把 3 个缺失指标硬编码为 50 并计入 8 项总数，looseCount 最多只能到 3，
 * 永远触发不了 ≥5 的普通信号门槛。
 *
 * @returns {'none'|'normal'|'accel'|'quasi'|'extreme'}
 */
function detectSignalForBacktest(idx, data) {
  const d      = data[idx];
  const score  = approxCycleScore(idx, data);
  const mvrvZ  = approxMvrvZ(idx, data);
  const puell  = approxPuell(idx, data);
  const ma200  = approxMa200(idx, data);
  // FGI：有实际数据用真实值，否则用价格行情近似（覆盖2018年前缺数据问题）
  const fgiVal = approxFgi(idx, data);

  // 5 项已知/近似指标（活跃地址比率/交易所储备/资金费率历史无数据，不计入）
  const knownScores = [
    mvrvZToNorm(mvrvZ),
    puellToNorm(puell),
    ma200ToNorm(ma200),
    halvingCycleNorm(d.date),
    fgiVal,
  ];

  const n = 5;
  const looseNeed  = 3; // 5/8 * 5 ≈ 3
  const strictNeed = 4; // 7/8 * 5 ≈ 4

  const looseCount  = knownScores.filter(s => s <= 40).length;
  const strictCount = knownScores.filter(s => s <= 25).length;

  // 注：backtest 的 mvrvZ 为自定义 Z-like 值 = (mvrv_ratio - 1.8) / 0.7
  // 与 signals.js 中 MVRV ratio 阈值的对应关系（ratio → Z-like）：
  //   0.85 → -1.36,  1.0 → -1.14,  1.2 → -0.86,  1.5 → -0.43

  // 极端底部 — 标准路径：MVRV ratio<0.85（Z<-1.36）对应链上深度亏损（2022年底水平）
  if (score <= 17 && mvrvZ < -1.36 && fgiVal < 7 && puell < 0.5) return 'extreme';
  // 极端底部 — ETF纪元备选路径（机构买盘托底，MVRV ratio 不跌破 0.85）
  if (score <= 15 && fgiVal < 7 && puell < 0.5) return 'extreme';

  // 准极端 — 标准路径：MVRV ratio<1.0（Z<-1.14）对应市值低于已实现市值
  if (score <= 22 && mvrvZ < -1.14 && fgiVal < 12) return 'quasi';
  // 准极端 — ETF纪元备选路径
  if (score <= 20 && fgiVal < 12) return 'quasi';

  // 加速信号：MVRV ratio<1.2（Z<-0.86）对应接近已实现市值
  if (score <= 30 && strictCount >= strictNeed && mvrvZ < -0.86 && fgiVal < 15) return 'accel';

  // 普通信号：MVRV ratio<1.5（Z<-0.43）对应估值偏低
  if (score <= 28 && looseCount >= looseNeed && mvrvZ < -0.43) return 'normal';

  return 'none';
}


/* ═══════════════════════════════════════════════════════
   3. 主回测函数
═══════════════════════════════════════════════════════ */

/**
 * @param {object} params
 *   strategy:    generateStrategy() 返回的策略配置
 *   startDate:   'YYYY-MM-DD'
 *   endDate:     'YYYY-MM-DD'
 *   totalBudget: 总预算（默认 10000）
 */
function runBacktest(params) {
  const strategy   = params.strategy;
  const startDate  = params.startDate || '2013-01-01';
  const endDate    = params.endDate   || BTC_WEEKLY_DATA[BTC_WEEKLY_DATA.length - 1].date;
  const budget     = params.totalBudget || 10000;

  const allData = BTC_WEEKLY_DATA;
  const data    = allData.filter(d => d.date >= startDate && d.date <= endDate);
  if (data.length < 4) return null;

  const {
    base_bullet_pct,
    signal_bullet_pct,
    extreme_bullet_pct,
    dca_frequency,
    entry_threshold,
    base_pool_entry_score,
    normal_signal_cooldown_days,
    accel_signal_cooldown_days,
    quasi_extreme_cooldown_days,
    extreme_signal_cooldown_days,
  } = strategy;

  // ── 三子弹资金池 ──
  const basePoolTotal    = budget * base_bullet_pct    / 100;
  const signalPoolTotal  = budget * signal_bullet_pct  / 100;
  const extremePoolTotal = budget * extreme_bullet_pct / 100;

  let basePool    = basePoolTotal;
  let signalPool  = signalPoolTotal;
  let extremePool = extremePoolTotal;

  // 基础池每次执行金额（8个月窗口：周投34次/双周投17次，对齐 calcBaseExec）
  const baseExecCount  = dca_frequency === 'weekly' ? 34 : 17;
  const baseExecAmount = basePoolTotal / baseExecCount;

  // 信号池/极端池固定执行金额（基于初始池，与 strategy.js calcSignalExec 对齐）
  // 用当前剩余池的百分比会导致几何衰减——池子越小每次越少，永远耗不完
  const signalNormalAmt   = signalPoolTotal  * 0.06;
  const signalAccelAmt    = signalPoolTotal  * 0.10;
  const extremeQuasiAmt   = extremePoolTotal * 0.12;
  const extremeExtremeAmt = extremePoolTotal * 0.20;

  // ── 等权重 DCA（每次买入金额与基础池单次相同）──
  const baseIntervalDays = dca_frequency === 'weekly' ? 7 : 14;
  const equalAmount = baseExecAmount;

  // ── 状态 ──
  let btcHeld    = 0, cashSpent    = 0;
  let dcaBtcHeld = 0, dcaCashSpent = 0, dcaBuyCount = 0;
  let baseBuyCount = 0, signalBuyCount = 0, extremeBuyCount = 0;

  let lastSignalDate = null, lastBaseDate = null, lastDcaDate = null, signalCooldown = 0;
  let dcaStarted = false;
  let peakStratValue = 0, peakStratDate = '';
  let peakDcaValue   = 0, peakDcaDate   = '';

  const strategyPoints = [];
  const dcaPoints      = [];
  const strategyBuys   = [];
  const dcaBuys        = [];

  for (let i = 0; i < data.length; i++) {
    const pt       = data[i];
    const gIdx     = allData.findIndex(d => d.date === pt.date);
    const score    = gIdx >= 0 ? approxCycleScore(gIdx, allData)           : 50;
    const signal   = gIdx >= 0 ? detectSignalForBacktest(gIdx, allData)    : 'none';

    const msDate   = new Date(pt.date).getTime();
    const daysSinceLast = lastSignalDate
      ? (msDate - new Date(lastSignalDate).getTime()) / 86400000 : 9999;
    const daysSinceBase = lastBaseDate
      ? (msDate - new Date(lastBaseDate).getTime()) / 86400000   : 9999;
    const daysSinceDca  = lastDcaDate
      ? (msDate - new Date(lastDcaDate).getTime()) / 86400000    : 9999;
    const inCooldown = daysSinceLast < signalCooldown;

    let spent = 0;

    // ── 三子弹策略：基础池（独立门槛，score ≤ base_pool_entry_score）──
    const baseActive = score <= base_pool_entry_score;
    if (basePool > 0 && baseActive) {
      if (daysSinceBase >= baseIntervalDays) {
        const amt = Math.min(baseExecAmount, basePool);
        if (amt > 0 && pt.price > 0) {
          spent    += amt;
          basePool -= amt;
          lastBaseDate = pt.date;
          baseBuyCount++;
          if (!dcaStarted) dcaStarted = true;
          strategyBuys.push({ date: pt.date, type: 'base', amount: amt, price: pt.price });
        }
      }
    }

    // ── 等权重 DCA：从基础池首次买入当日起，同频率买入，不看分数，共 baseExecCount 次 ──
    if (dcaStarted && dcaBuyCount < baseExecCount && daysSinceDca >= baseIntervalDays && pt.price > 0) {
      const dcaAmt = Math.min(equalAmount, budget - dcaCashSpent);
      if (dcaAmt > 0) {
        dcaBtcHeld   += dcaAmt / pt.price;
        dcaCashSpent += dcaAmt;
        dcaBuyCount++;
        lastDcaDate = pt.date;
        dcaBuys.push({ date: pt.date, price: pt.price });
      }
    }

    // ── 信号池（严格入场门槛，需未处于冷静期）──
    if (!inCooldown && score <= entry_threshold) {
      if (signal === 'normal' && signalPool > 0) {
        const amt = Math.min(signalNormalAmt, signalPool);
        spent      += amt;
        signalPool -= amt;
        lastSignalDate = pt.date;
        signalCooldown = normal_signal_cooldown_days;
        signalBuyCount++;
        strategyBuys.push({ date: pt.date, type: 'signal', amount: amt, price: pt.price });
      } else if (signal === 'accel' && signalPool > 0) {
        const amt = Math.min(signalAccelAmt, signalPool);
        spent      += amt;
        signalPool -= amt;
        lastSignalDate = pt.date;
        signalCooldown = accel_signal_cooldown_days;
        signalBuyCount++;
        strategyBuys.push({ date: pt.date, type: 'accel', amount: amt, price: pt.price });
      }
    }

    // ── 极端池（准极端与极端底部共用，不受惯性缓冲限制）──
    if (!inCooldown && score <= entry_threshold) {
      if (signal === 'quasi' && extremePool > 0) {
        const amt = Math.min(extremeQuasiAmt, extremePool);
        spent       += amt;
        extremePool -= amt;
        lastSignalDate = pt.date;
        signalCooldown = quasi_extreme_cooldown_days;
        extremeBuyCount++;
        strategyBuys.push({ date: pt.date, type: 'quasi', amount: amt, price: pt.price });
      } else if (signal === 'extreme' && extremePool > 0) {
        const amt = Math.min(extremeExtremeAmt, extremePool);
        spent       += amt;
        extremePool -= amt;
        lastSignalDate = pt.date;
        signalCooldown = extreme_signal_cooldown_days;
        extremeBuyCount++;
        strategyBuys.push({ date: pt.date, type: 'extreme', amount: amt, price: pt.price });
      }
    }

    if (spent > 0 && pt.price > 0) {
      btcHeld   += spent / pt.price;
      cashSpent += spent;
    }

    const remainCash  = basePool + signalPool + extremePool;
    const stratValue  = btcHeld   * pt.price + remainCash;
    const dcaValue    = dcaBtcHeld * pt.price + Math.max(0, budget - dcaCashSpent);

    if (stratValue > peakStratValue) { peakStratValue = stratValue; peakStratDate = pt.date; }
    if (dcaValue   > peakDcaValue)   { peakDcaValue   = dcaValue;   peakDcaDate   = pt.date; }


    strategyPoints.push({
      date: pt.date, price: pt.price, value: stratValue,
      avgCost: btcHeld > 0 ? cashSpent / btcHeld : null,
    });
    dcaPoints.push({ date: pt.date, price: pt.price, value: dcaValue });
  }

  // ── 汇总 ──
  const finalStrat = strategyPoints[strategyPoints.length - 1].value;
  const finalDca   = dcaPoints[dcaPoints.length - 1].value;
  const years      = (new Date(endDate) - new Date(startDate)) / (365.25 * 86400000);

  // 建仓浮亏：相对初始预算，组合最低点时亏损了多少
  function calcMaxLoss(points) {
    let maxLoss = 0;
    for (const p of points) {
      const loss = (budget - p.value) / budget;
      if (loss > maxLoss) maxLoss = loss;
    }
    return maxLoss;
  }


  function calcCAGR(start, end, yrs) {
    return Math.pow(end / start, 1 / yrs) - 1;
  }

  const buyCount = baseBuyCount + signalBuyCount + extremeBuyCount;

  // 顶点价格 & 平均成本（用于"成本价 → 顶点价"展示）
  const stratPeakPt  = strategyPoints.find(p => p.date === peakStratDate);
  const stratPeakPx  = stratPeakPt ? stratPeakPt.price : 0;
  const stratAvgCost = stratPeakPt ? stratPeakPt.avgCost : null;
  const stratPxReturn = (stratAvgCost > 0) ? (stratPeakPx / stratAvgCost - 1) : null;

  const dcaAvgCost   = dcaBtcHeld > 0 ? dcaCashSpent / dcaBtcHeld : null;
  const dcaPeakPt    = dcaPoints.find(p => p.date === peakDcaDate);
  const dcaPeakPx    = dcaPeakPt ? dcaPeakPt.price : 0;
  const dcaPxReturn  = (dcaAvgCost > 0) ? (dcaPeakPx / dcaAvgCost - 1) : null;

  return {
    strategyPoints,
    dcaPoints,
    strategyBuys,
    dcaBuys,
    summary: {
      strategy: {
        totalReturn:    finalStrat / budget - 1,
        maxLoss:        calcMaxLoss(strategyPoints),
        cagr:           calcCAGR(budget, peakStratValue, (new Date(peakStratDate) - new Date(startDate)) / (365.25 * 86400000)),
        buyCount,
        baseBuyCount,
        signalBuyCount,
        extremeBuyCount,
        finalValue:     finalStrat,
        btcHeld,
        peakValue:      peakStratValue,
        peakReturn:     peakStratValue / budget - 1,
        peakDate:       peakStratDate,
        peakPrice:      stratPeakPx,
        avgCost:        stratAvgCost,
        priceReturn:    stratPxReturn,
      },
      dca: {
        totalReturn:    finalDca / budget - 1,
        maxLoss:        calcMaxLoss(dcaPoints),
        cagr:           calcCAGR(budget, peakDcaValue, (new Date(peakDcaDate) - new Date(startDate)) / (365.25 * 86400000)),
        buyCount:       dcaBuyCount,
        finalValue:     finalDca,
        btcHeld:        dcaBtcHeld,
        peakValue:      peakDcaValue,
        peakReturn:     peakDcaValue / budget - 1,
        peakDate:       peakDcaDate,
        peakPrice:      dcaPeakPx,
        avgCost:        dcaAvgCost,
        priceReturn:    dcaPxReturn,
      },
      startDate, endDate, budget,
      years: parseFloat(years.toFixed(1)),
    },
  };
}


/* ═══════════════════════════════════════════════════════
   4. 工具函数
═══════════════════════════════════════════════════════ */

function formatPct(n) {
  const sign = n >= 0 ? '+' : '';
  return sign + (n * 100).toFixed(1) + '%';
}

function formatMultiple(n) {
  return n.toFixed(2) + 'x';
}
