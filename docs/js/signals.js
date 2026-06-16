/**
 * signals.js — 8指标周期分数计算 (v1.2)
 *
 * 权重分配（分数越低 = 市场越低估）：
 *   MVRV ratio      25%   链上估值核心指标（数据源：CoinMetrics CapMVRVCur，MVRV ratio）
 *   Puell Multiple  20%   矿工收入 / 365日均
 *   NUPL / SOPR     15%   未实现净盈亏
 *   交易所储备量    10%   持续下降 = 用户提链
 *   恐慌贪婪指数   15%   市场情绪综合指标
 *   资金费率        5%   永续合约资金费率
 *   减半周期        5%   相对减半事件的时间位置
 *   ETF 资金流向    5%   现货 ETF 净流入/流出
 *
 * 评分区间：0-25 极端底部 / 25-45 熊市积累 / 45-70 震荡中性 / 70-100 高估预警
 */

const SIGNALS_URL = './signals-feed.json';

/**
 * 拉取 signals-feed.json
 * @returns {Promise<object>}
 */
async function fetchSignals() {
  const res = await fetch(SIGNALS_URL + '?t=' + Date.now());
  if (!res.ok) throw new Error('无法获取信号数据');
  return res.json();
}

/**
 * 实时 BTC 价格 — 依次尝试多个数据源，返回第一个成功值
 * @returns {Promise<number>} USD 价格
 */
async function fetchLivePrice() {
  const sources = [
    // Binance 全球节点
    async () => {
      const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
      const d = await r.json(); return parseFloat(d.price);
    },
    // Coinbase 公开 API（国内通常可达）
    async () => {
      const r = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
      const d = await r.json(); return parseFloat(d.data.amount);
    },
    // CoinGecko 免费 API
    async () => {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
      const d = await r.json(); return d.bitcoin.usd;
    },
  ];
  for (const fn of sources) {
    try {
      const price = await fn();
      if (price > 0) return price;
    } catch { /* 尝试下一个 */ }
  }
  throw new Error('all price sources failed');
}

/**
 * 实时恐慌贪婪指数（Alternative.me）
 * @returns {Promise<{value: number, label: string}>}
 */
async function fetchLiveFGI() {
  const res = await fetch('https://api.alternative.me/fng/?limit=1');
  if (!res.ok) throw new Error('FGI fetch failed');
  const data = await res.json();
  const entry = data.data[0];
  return { value: parseInt(entry.value, 10), label: entry.value_classification };
}

/**
 * 实时资金费率（Bybit 公开 API）
 * @returns {Promise<number>} 资金费率（如 -0.0001）
 */
async function fetchLiveFundingRate() {
  const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT');
  if (!res.ok) throw new Error('funding rate fetch failed');
  const data = await res.json();
  // Bybit returns decimal ratio (0.0001 = 0.01%); convert to percent to match signals-feed.json convention
  return parseFloat((parseFloat(data.result.list[0].fundingRate) * 100).toFixed(4));
}

/**
 * 读取预计算的 cycle_score；降级时本地计算
 * @param {object} data
 * @returns {number} 0-100
 */
function computeCycleScore(data) {
  if (typeof data.cycle_score === 'number') return data.cycle_score;

  // 降级模式：FGI + 资金费率 + 减半周期，权重 3:1:1
  const fgi = data.fgi?.normalized_score           ?? 50;
  const fr  = data.funding_rate?.normalized_score  ?? 50;
  const hc  = data.halving_cycle?.normalized_score ?? 50;
  return Math.round(fgi * 0.6 + fr * 0.2 + hc * 0.2);
}

/**
 * 返回 score 对应的区间名（用于 UI 显示）
 * @param {number} score
 * @returns {{ zone: string, cls: string }}
 */
function scoreZone(score) {
  if (score < 25)  return { zone: '极端底部', cls: 'bottom' };
  if (score < 45)  return { zone: '熊市积累', cls: 'bear'   };
  if (score < 70)  return { zone: '震荡中性', cls: 'neutral' };
  return               { zone: '高估预警', cls: 'high'    };
}

/**
 * 判断当前信号等级（基于8指标共振逻辑）
 * @param {object} data
 * @returns {{ level: string, label: string, detail: string, conditions: array }}
 */
function detectSignalLevel(data) {
  const score    = computeCycleScore(data);
  const mvrzVal  = data.mvrv_ratio?.value           ?? 999;
  const nuplVal  = data.nupl?.value             ?? 0;
  const fgiVal   = data.fgi?.value              ?? 50;
  const puellVal = data.puell_multiple?.value   ?? 999;

  // 8 项归一化分数列表
  const scores = [
    data.mvrv_ratio?.normalized_score            ?? 50,
    data.puell_multiple?.normalized_score    ?? 50,
    data.nupl?.normalized_score              ?? 50,
    data.exchange_reserves?.normalized_score ?? 50,
    data.fgi?.normalized_score               ?? 50,
    data.funding_rate?.normalized_score      ?? 50,
    data.halving_cycle?.normalized_score     ?? 50,
    data.etf_flow?.normalized_score          ?? 50,
  ];

  // 宽松低分区 ≤40；严格低分区 ≤25
  const looseCount  = scores.filter(s => s <= 40).length;
  const strictCount = scores.filter(s => s <= 25).length;

  // 极端底部 — 标准路径：score≤17 + MVRV ratio<0.85 + FGI<7 + Puell<0.5
  // MVRV ratio < 0.85：市值低于已实现市值 85%，链上深度亏损（类 2022 年底水平）
  if (score <= 17 && mvrzVal < 0.85 && fgiVal < 7 && puellVal < 0.5) {
    return {
      level: 'extreme', label: '极端底部信号',
      detail: '所有极端条件齐发，历史级别建仓时机',
      conditions: [
        { met: true, text: `周期分 ${score}，进入历史极端底部区（≤ 17）` },
        { met: true, text: `MVRV ratio ${mvrzVal.toFixed(2)}，链上持仓深度亏损（< 0.85）` },
        { met: true, text: `恐慌贪婪指数 ${fgiVal}/100，极度恐慌（< 7）` },
        { met: true, text: `Puell Multiple ${puellVal.toFixed(2)}，矿工深度亏损期（< 0.5）` },
      ],
    };
  }

  // 极端底部 — ETF纪元备选路径：机构买盘托底使 MVRV ratio 不再跌破 0.85，改用更低周期分替代
  if (score <= 15 && fgiVal < 7 && puellVal < 0.5) {
    return {
      level: 'extreme', label: '极端底部信号（ETF纪元）',
      detail: '周期分极低且市场极度恐慌，MVRV ratio 因机构买盘维持偏高',
      conditions: [
        { met: true,          text: `周期分 ${score}，ETF纪元严格极端底部区（≤ 15）` },
        { met: true,          text: `恐慌贪婪指数 ${fgiVal}/100，极度恐慌（< 7）` },
        { met: true,          text: `Puell Multiple ${puellVal.toFixed(2)}，矿工深度亏损期（< 0.5）` },
        { met: mvrzVal < 0.85, text: `MVRV ratio ${mvrzVal.toFixed(2)}${mvrzVal < 0.85 ? '（< 0.85，深度亏损）' : '（≥ 0.85，ETF纪元结构性支撑）'}` },
      ],
    };
  }

  // 准极端 — 标准路径：score≤22 + MVRV ratio<1.0 + NUPL<0 + FGI<12
  // MVRV ratio < 1.0：市值低于已实现市值，市场整体持仓亏损
  if (score <= 22 && mvrzVal < 1.0 && nuplVal < 0 && fgiVal < 12) {
    return {
      level: 'quasi', label: '准极端信号',
      detail: '多项底部信号共振，建议重点分批建仓',
      conditions: [
        { met: score <= 22,    text: `周期分 ${score}（≤ 22）` },
        { met: mvrzVal < 1.0,  text: `MVRV ratio ${mvrzVal.toFixed(2)}（< 1.0，市值低于已实现市值）` },
        { met: nuplVal < 0,    text: `NUPL ${nuplVal.toFixed(2)}（< 0，持仓整体亏损）` },
        { met: fgiVal < 12,    text: `恐慌贪婪指数 ${fgiVal}（< 12，极度恐慌）` },
      ],
    };
  }

  // 准极端 — ETF纪元备选路径：机构买盘托底使 MVRV ratio 不跌破 1.0，改用更低周期分替代
  if (score <= 20 && fgiVal < 12) {
    return {
      level: 'quasi', label: '准极端信号（ETF纪元）',
      detail: '周期分极低且市场极度恐慌，MVRV ratio 因机构买盘维持偏高',
      conditions: [
        { met: true,          text: `周期分 ${score}，ETF纪元严格准极端区（≤ 20）` },
        { met: true,          text: `恐慌贪婪指数 ${fgiVal}（< 12，极度恐慌）` },
        { met: mvrzVal < 1.0, text: `MVRV ratio ${mvrzVal.toFixed(2)}${mvrzVal < 1.0 ? '（< 1.0，持仓亏损）' : '（≥ 1.0，ETF纪元结构性支撑）'}` },
      ],
    };
  }

  // 加速信号：score≤30 + 7+ 项严格低分区 + MVRV ratio<1.2 + FGI<15
  if (score <= 30 && strictCount >= 7 && mvrzVal < 1.2 && fgiVal < 15) {
    return {
      level: 'accel', label: '加速定投信号',
      detail: `${strictCount}/8 项指标深度低估，多重底部信号共振`,
      conditions: [
        { met: score <= 30,      text: `周期分 ${score}（≤ 30）` },
        { met: strictCount >= 7, text: `${strictCount}/8 项归一化分 ≤ 25，深度低估` },
        { met: mvrzVal < 1.2,    text: `MVRV ratio ${mvrzVal.toFixed(2)}（< 1.2，接近已实现市值）` },
        { met: fgiVal < 15,      text: `恐慌贪婪指数 ${fgiVal}（< 15，极度恐慌）` },
      ],
    };
  }

  // 普通信号：score≤28 + 5+ 项宽松低分区 + MVRV ratio<1.5
  const conditionList = [
    { met: score <= 28,      text: `综合周期分 ${score}（≤ 28）` },
    { met: looseCount >= 5,  text: `${looseCount}/8 项指标归一化 ≤ 40，低估共振` },
    { met: mvrzVal < 1.5,    text: `MVRV ratio ${mvrzVal.toFixed(2)}（< 1.5，估值偏低）` },
  ];

  if (score <= 28 && looseCount >= 5 && mvrzVal < 1.5) {
    return {
      level: 'normal', label: '普通定投信号',
      detail: `市场进入低廉估值区，维持正常定投节奏`,
      conditions: conditionList,
    };
  }

  return {
    level: 'none', label: '无信号',
    detail: '当前估值偏高或中性，保持基础定投节奏',
    conditions: conditionList,
  };
}

/**
 * 检查慢变量（Puell / NUPL / 交易所储备）的数据新鲜度
 * 这三项无免费实时 API，由脚本保留上次已知值；超过 14 天应提示用户手动核实
 * @param {object} data signals-feed.json 解析结果
 * @returns {{ stale: boolean, daysSince: number|null }}
 */
function checkSlowVarsFreshness(data) {
  const dateStr = data.slow_vars_updated_at;
  if (!dateStr) return { stale: false, daysSince: null };
  const daysSince = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  return { stale: daysSince > 14, daysSince };
}
