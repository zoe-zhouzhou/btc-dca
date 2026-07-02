/**
 * strategy.js — 策略生成逻辑 v2
 *
 * 依赖：signals.js（computeCycleScore、detectSignalLevel）
 *
 * 对外暴露：
 *   generateStrategy(scores)                          → 策略配置对象
 *   dcaFreqLabel(freq)                                → 中文频率标签
 *   calcAmounts(strategy, budget)                     → 各池绝对金额
 *   calcBaseExec(amounts, strategy)                   → 每次基础定投金额
 *   calcSignalExec(amounts, signalLevel)              → 信号触发执行金额
 *   entryTimingDesc(score, threshold, name, signal)   → 入场时机判断
 *   evaluateAllSignalLevels(data)                     → 四级信号条件评估
 *   LOSS_ANCHORS                                      → 深度亏损三档锚定
 *   EXIT_CONDITIONS                                   → 退出定投条件
 *   formatBudget(n)                                   → 金额格式化
 *   historicalWindowDesc(score)                       → 历史参考窗口描述
 */

/* ─────────────────────────────────────────
   策略生成
───────────────────────────────────────── */

/**
 * 根据 5 维评分生成策略配置
 * @param {{ fn, r, kn, fs, eh }} scores 各维度 1–5 分
 * @returns {object} 策略配置
 */
function generateStrategy(scores) {
  const { fn, r, kn, fs, eh } = scores;

  // 综合风险承受度（1–5 区间）
  const risk = (fn * 2 + r * 2 + fs + eh) / 7;

  // ── 三子弹比例 ──────────────────────────────────
  // 极端池大幅加重：历史上极端底部是最高胜率买点，集中更多弹药；基础池减轻；信号池固定 30%
  let basePct, extremePct;
  if      (risk >= 4.0) { basePct = 15; extremePct = 55; }
  else if (risk >= 3.5) { basePct = 20; extremePct = 50; }
  else if (risk >= 2.5) { basePct = 25; extremePct = 45; }
  else if (risk >= 1.8) { basePct = 35; extremePct = 35; }
  else                  { basePct = 45; extremePct = 25; }
  const signalPct = 100 - basePct - extremePct;

  // ── 定投频率：仅周投 / 双周投 ──────────────────
  const dcaFrequency = risk >= 4.0 ? 'weekly' : 'biweekly';

  // ── 冷静期（normal/accel 按心理韧性 r 浮动；quasi/extreme 固定短周期，底部窗口短需快速部署）──
  let normalCooldown, accelCooldown;
  if (r >= 4) {
    normalCooldown = 7;  accelCooldown = 10;
  } else if (r >= 3) {
    normalCooldown = 8;  accelCooldown = 12;
  } else {
    normalCooldown = 10; accelCooldown = 14;
  }
  // quasi/extreme 不受用户韧性影响：极端底部出现窗口通常 ≤ 3 个月，需快速打出弹药
  const quasiCooldown    = 7;
  const extremeCooldown  = 7;

  // ── 单次最大仓位 ──────────────────────────────
  let maxSinglePct;
  if      (r >= 4 && kn >= 4) maxSinglePct = 25;
  else if (r >= 3 && kn >= 3) maxSinglePct = 20;
  else                        maxSinglePct = 15;

  // 基础池触发门槛：与信号池对齐，28 分以下才开始基础定投
  const baseBulletEntryScore = 28;

  // ── 信号 score 门槛（普通 + 加速共用，保守画像更晚触发）──
  let signalScoreThreshold;
  if      (risk >= 4.0) signalScoreThreshold = 30;
  else if (risk >= 2.5) signalScoreThreshold = 28;
  else if (risk >= 1.8) signalScoreThreshold = 25;
  else                  signalScoreThreshold = 22;

  return {
    base_bullet_pct:              basePct,
    signal_bullet_pct:            signalPct,
    extreme_bullet_pct:           extremePct,
    dca_frequency:                dcaFrequency,
    base_pool_entry_score:        baseBulletEntryScore,
    normal_signal_cooldown_days:  normalCooldown,
    accel_signal_cooldown_days:   accelCooldown,
    quasi_extreme_cooldown_days:  quasiCooldown,
    extreme_signal_cooldown_days: extremeCooldown,
    max_single_position_pct:      maxSinglePct,
    signal_score_threshold:       signalScoreThreshold,
  };
}

/* ─────────────────────────────────────────
   频率标签
───────────────────────────────────────── */

/**
 * @param {string} freq 'weekly' | 'biweekly'
 * @returns {string}
 */
function dcaFreqLabel(freq) {
  return freq === 'weekly' ? '每周' : '每两周';
}

/* ─────────────────────────────────────────
   金额计算
───────────────────────────────────────── */

/**
 * 各池绝对金额
 * @param {object} strategy generateStrategy() 结果
 * @param {number} budget   用户总预算
 * @returns {{ base, signal, extreme }}
 */
function calcAmounts(strategy, budget) {
  return {
    base:    Math.round(budget * strategy.base_bullet_pct    / 100),
    signal:  Math.round(budget * strategy.signal_bullet_pct  / 100),
    extreme: Math.round(budget * strategy.extreme_bullet_pct / 100),
  };
}

/**
 * 每次基础定投金额（按 8 个月底部窗口摊算）
 * @param {{ base }} amounts
 * @param {object}  strategy
 * @returns {number}
 */
function calcBaseExec(amounts, strategy, windowsOrMonths) {
  var months;
  if (windowsOrMonths && typeof windowsOrMonths === 'object' && typeof windowsOrMonths.below28 === 'number') {
    months = windowsOrMonths.below28;
  } else if (typeof windowsOrMonths === 'number' && windowsOrMonths > 0) {
    months = windowsOrMonths;
  } else {
    months = 8;
  }
  var periodsPerMonth = strategy.dca_frequency === 'weekly' ? 4 : 2;
  return Math.round(amounts.base / Math.max(1, Math.round(months * periodsPerMonth)));
}

/**
 * 信号触发时单次执行金额
 * @param {{ signal, extreme }} amounts
 * @param {'normal'|'accel'|'quasi'|'extreme'} signalLevel
 * @returns {{ amount: number, batches: number, batchAmount: number }}
 */
function calcSignalExec(amounts, signalLevel, windows, signalThreshold) {
  // 各阈值的历史基准月数（与 estimateWindowsByThreshold 保持一致）
  var HIST = { below30: 8, below28: 7, below25: 5, below22: 4, below17: 2 };
  // 根据画像 signal_score_threshold 选择对应窗口 key
  var sigKey = 'below' + (signalThreshold || 28);
  var WMAP = { normal: sigKey, accel: sigKey, quasi: 'below22', extreme: 'below17' };
  var m = 1.0;
  if (windows && typeof windows === 'object') {
    var wKey = WMAP[signalLevel];
    var w    = windows[wKey];
    var b    = HIST[wKey] || 7;
    if (w === undefined || w === null) m = 1.0;
    else if (w === 0)                  m = 2.0;
    else m = Math.max(0.5, Math.min(2.0, b / w));
  } else if (typeof windows === 'number') {
    m = windows; // 向下兼容：直接传 urgencyMultiplier 数字
  }
  var config = {
    normal:  { base: 0.06, min: 0.03, max: 0.12, pool: amounts.signal  },
    accel:   { base: 0.10, min: 0.05, max: 0.18, pool: amounts.signal  },
    quasi:   { base: 0.12, min: 0.07, max: 0.22, pool: amounts.extreme },
    extreme: { base: 0.20, min: 0.12, max: 0.35, pool: amounts.extreme },
  };
  var cfg = config[signalLevel];
  if (!cfg) return { amount: 0, pct: 0, batches: 1, batchAmount: 0 };
  var rawPct = cfg.base * m;
  var pct    = Math.max(cfg.min, Math.min(cfg.max, rawPct));
  var a      = Math.round(cfg.pool * pct);
  return { amount: a, pct: Math.round(pct * 1000) / 10, batches: 1, batchAmount: a };
}

/**
 * 格式化预算金额（加千分位逗号）
 * @param {number} n
 * @returns {string}
 */
function formatBudget(n) {
  if (!n && n !== 0) return '—';
  return n.toLocaleString('zh-CN');
}

/* ─────────────────────────────────────────
   周期 / 容量辅助函数
───────────────────────────────────────── */

/**
 * 基础定投总批次（8 个月窗口）
 * @param {object} strategy generateStrategy() 结果
 * @returns {number} 34（周投）或 17（双周投）
 */
function getTimesPerYear(strategy) {
  return strategy.dca_frequency === 'weekly' ? 34 : 17;
}

/**
 * 信号池最大触发次数（按每种信号独立计算）
 * 普通信号每次消耗 6%，最多触发 16 次（16×6%=96%）
 * 加速信号每次消耗 10%，最多触发 10 次（10×10%=100%）
 * 实际混用时按消耗累加，剩余部分留给后续信号
 */
function calcSignalCapacity() {
  return {
    normal: Math.floor(100 / 6),  // = 16
    accel:  Math.floor(100 / 10), // = 10
  };
}

/**
 * 低估区已持续月数
 * @param {string|null} undervaluedSince ISO 日期字符串（如 "2025-09-20"）或 null
 * @returns {number|null}
 */
function bearDurationMonths(undervaluedSince) {
  if (!undervaluedSince) return null;
  var start  = new Date(undervaluedSince);
  var now    = new Date();
  return Math.round((now - start) / (1000 * 60 * 60 * 24 * 30.44));
}

/* ─────────────────────────────────────────
   入场时机判断
───────────────────────────────────────── */

/**
 * @param {number} cycleScore  当前周期分
 * @param {number} threshold   基础池触发门槛（base_pool_entry_score）
 * @param {string} personaName 画像名称
 * @param {object} signal      detectSignalLevel() 结果
 * @returns {{ verdict, reason, color, canEnter }}
 */
function entryTimingDesc(cycleScore, threshold, personaName, signal) {
  const canEnter = cycleScore <= threshold;

  if (!canEnter) {
    return {
      canEnter: false,
      verdict:  '暂不建议入场',
      reason:   `周期评分 ${cycleScore} 分，高于基础池触发门槛 ${threshold} 分。当前市场估值偏高，历史上在此区间建仓的长期胜率较低。建议保持观望，等待周期分回落至 ${threshold} 分以下后再开始定投。`,
      color:    'red',
    };
  }

  // 已达门槛 — 根据信号等级补充说明
  const signalMap = {
    extreme: `当前还触发了极端底部信号，历史上这是最稀少的买入窗口，建议在基础定投之外动用极端池弹药。`,
    quasi:   `当前还触发了准极端信号，可在基础定投之外动用极端池 20%，单次执行。`,
    accel:   `当前还触发了加速信号，可在基础定投之外追加信号池 10% 建仓。`,
    normal:  `当前触发了普通信号，可在基础定投之外追加信号池 6% 建仓。`,
    none:    `当前无强信号，按基础节奏开始即可，不需要等待更低的价格。`,
  };

  return {
    canEnter: true,
    verdict:  '现在入场是合理的',
    reason:   `周期评分 ${cycleScore} 分，已低于基础池触发门槛 ${threshold} 分。链上数据显示市场处于低估区间，历史上在此区间开始定投的中长期胜率较高。建议本周期内执行第一笔基础仓位。${signalMap[signal.level] || signalMap.none}`,
    color:    'green',
  };
}

/* ─────────────────────────────────────────
   四级信号条件评估（含实时数值）
───────────────────────────────────────── */

/**
 * @param {object} data signals-feed.json 解析结果
 * @returns {Array} 四级信号描述数组（与 detectSignalLevel 逻辑对齐）
 */
function evaluateAllSignalLevels(data, thresholds) {
  const score    = computeCycleScore(data);
  const mvrzVal  = data.mvrv_ratio?.value        ?? 999;
  const fgiVal   = data.fgi?.value              ?? 50;
  const puellVal = data.puell_multiple?.value   ?? 999;
  const sigThreshold = (thresholds && thresholds.signal_score_threshold) || 28;

  const normScores = [
    data.mvrv_ratio?.normalized_score         ?? 50,
    data.puell_multiple?.normalized_score    ?? 50,
    data.adr_act?.normalized_score           ?? 50,
    data.exchange_reserves?.normalized_score ?? 50,
    data.fgi?.normalized_score               ?? 50,
    data.funding_rate?.normalized_score      ?? 50,
    data.halving_cycle?.normalized_score     ?? 50,
    data.ma_200d?.normalized_score          ?? 50,
  ];

  const looseCount  = normScores.filter(s => s <= 40).length;
  const strictCount = normScores.filter(s => s <= 25).length;

  return [
    {
      key:         'normal',
      label:       '普通信号',
      color:       'green',
      actionPct:   '信号池 6%',
      cooldownKey: 'normal_signal_cooldown_days',
      cooldownWhy: '每次消耗 6%，配合冷静期可覆盖约 16 次触发窗口（约 4 个月），不会在底部早段就耗尽弹药。',
      note:        '3 项全部满足触发',
      conditions: [
        { text: `周期分 ≤ ${sigThreshold}`,  value: `当前 ${score}`,                          met: score <= sigThreshold },
        { text: '8 指标中 5 项以上低估',    value: `当前 ${looseCount}/8 项归一化分 ≤ 40`, met: looseCount >= 5 },
        { text: 'MVRV ratio < 1.5',         value: `当前 ${mvrzVal.toFixed(2)}`,             met: mvrzVal < 1.5 },
      ],
    },
    {
      key:         'accel',
      label:       '加速信号',
      color:       'amber',
      actionPct:   '信号池 10%',
      cooldownKey: 'accel_signal_cooldown_days',
      cooldownWhy: '每次消耗 10%，触发条件更严苛，市场更低估。信号池可支撑约 10 次加速触发。',
      note:        '4 项全部满足触发',
      conditions: [
        { text: `周期分 ≤ ${sigThreshold}`,  value: `当前 ${score}`,                           met: score <= sigThreshold },
        { text: '8 指标中 7 项严格低估',    value: `当前 ${strictCount}/8 项归一化分 ≤ 25`, met: strictCount >= 7 },
        { text: 'MVRV ratio < 1.2',          value: `当前 ${mvrzVal.toFixed(2)}`,              met: mvrzVal < 1.2 },
        { text: 'FGI < 15',                value: `当前 ${fgiVal}`,                          met: fgiVal < 15 },
      ],
    },
    {
      key:         'quasi',
      label:       '准极端信号',
      color:       'amber',
      actionPct:   '极端池 12%',
      cooldownKey: 'quasi_extreme_cooldown_days',
      cooldownWhy: '准极端与极端底部共用极端池，每次打 12%，7 天冷静期，可覆盖约 8 次触发（约 8 周底部窗口）。',
      note:        '3 项全部满足触发；或 ETF纪元备选：周期分≤20 且 FGI<12',
      conditions: [
        { text: '周期分 ≤ 22',      value: `当前 ${score}`,               met: score <= 22 },
        { text: 'MVRV ratio < 1.0', value: `当前 ${mvrzVal.toFixed(2)}`,   met: mvrzVal < 1.0 },
        { text: 'FGI < 12',         value: `当前 ${fgiVal}`,               met: fgiVal < 12 },
      ],
    },
    {
      key:         'extreme',
      label:       '极端底部信号',
      color:       'red',
      actionPct:   '极端池 20%',
      cooldownKey: 'extreme_signal_cooldown_days',
      cooldownWhy: '极端底部条件最严苛，每次打 20%（比准极端多 8%），历史上每轮熊市仅出现 1–3 次，集中火力打在最底部。',
      note:        '4 项全部满足触发；或 ETF纪元备选：周期分≤15 且 FGI<7 且 Puell<0.5',
      conditions: [
        { text: '周期分 ≤ 17',              value: `当前 ${score}`,               met: score <= 17 },
        { text: 'MVRV ratio < 0.85',       value: `当前 ${mvrzVal.toFixed(2)}`,   met: mvrzVal < 0.85 },
        { text: 'FGI < 7',                 value: `当前 ${fgiVal}`,               met: fgiVal < 7 },
        { text: 'Puell Multiple < 0.5',    value: `当前 ${puellVal.toFixed(2)}`,  met: puellVal < 0.5 },
      ],
    },
  ];
}

/* ─────────────────────────────────────────
   深度亏损锚定（三档固定文案）
───────────────────────────────────────── */

const LOSS_ANCHORS = [
  {
    threshold: '浮亏 20% 以内',
    title:     '正常范围，继续执行',
    desc:      '历史回测显示，2018 和 2022 两轮熊市中，三子弹策略的账面最大浮亏分别为 18.9% 和 10.9%。这个区间是策略设计预期内的正常波动，不是出了问题。继续按计划执行，不做任何额外操作。',
    color:     'green',
  },
  {
    threshold: '浮亏约 25%',
    title:     '超出历史基准，打开宣言',
    desc:      '这个浮亏水平已超出历史回测的正常范围，市场可能正在经历比过去更极端的下跌。此时唯一正确的行动是：打开你的定投宣言重读一遍，然后关掉行情软件。不做新决策，不卖出，继续执行计划中的信号触发。',
    color:     'amber',
  },
  {
    threshold: '浮亏 30% 以上',
    title:     '极端场景，检查极端池弹药',
    desc:      '这超出了历史上任何一轮熊市的回测结果，说明市场正在经历历史级别的极端行情。检查极端池是否还有剩余——这正是极端池设计的使用场景。不要卖出，不要改变计划。此刻的恐惧，正是策略设计时预见到的场景。',
    color:     'red',
  },
];

/* ─────────────────────────────────────────
   退出定投条件
───────────────────────────────────────── */

const EXIT_CONDITIONS = {
  system: [
    {
      label: '周期分持续 ≥ 85 分超过 4 周',
      desc:  '市场进入极度高估区间，系统建议暂停所有新建仓位。不是要你卖出，是停止继续买入。',
    },
    {
      label: 'MVRV 超过 3.0',
      desc:  '历史上 MVRV > 3.0 区间是牛市中后段，继续建仓的风险收益比显著恶化，建议暂停定投。',
    },
    {
      label: '三池子弹全部用完',
      desc:  '基础池、信号池、极端池均已耗尽，定投自动结束。这意味着你已完整执行了建仓计划。除非你有意识地追加预算并重新评估策略，否则不需要继续买入。',
    },
  ],
  personal: [
    {
      label: '达到你的投资时间线',
      desc:  '你在问卷中设定了退出时间线。到达时不是必须卖出，而是主动评估一次：目标达到了吗？是否还需要继续持有？',
    },
    {
      label: '达到目标收益倍数',
      desc:  '建议现在就写下你的目标（如 3× 或 5×）。到达后按计划分批减仓，不要因为"可能还会涨"而无限推迟。',
    },
  ],
};

/* ─────────────────────────────────────────
   历史参考窗口
   基于过去三轮熊市（2015 / 2019 / 2022–23）的底部区间持续时长
───────────────────────────────────────── */

/**
 * 根据当前周期分返回历史同等估值区间的持续时间参考
 * @param {number} score 当前周期分（0–100）
 * @returns {{ range: string, context: string } | null}
 *   score ≥ 55 时返回 null（市场不在低估区，不展示）
 */
function historicalWindowDesc(score) {
  if (score < 25) {
    return {
      range:   '7–14 个月',
      context: '基于过去三轮熊市，完整熊市底部阶段（周期分 0–45）持续约 7–14 个月（2015 年约 14 个月、2019 年约 7 个月、2022 年约 9 个月）。当前已进入极端底部区（< 25 分），通常是整个底部阶段的最后 3–5 个月。极端池弹药已进入待命状态，待准极端或极端底部信号条件满足后应优先部署。',
    };
  }
  if (score < 45) {
    return {
      range:   '7–14 个月',
      context: '基于过去三轮熊市，完整熊市底部阶段（周期分 0–45）持续约 7–14 个月（2015 年约 14 个月、2019 年约 7 个月、2022 年约 9 个月），是定投系统三池弹药的主要执行窗口。',
    };
  }
  if (score < 55) {
    return {
      range:   '4–16 个月',
      context: '基于历史数据，低估观望区间（周期分 45–55）持续时间差异较大，最短约 4 个月，最长超过一年。策略设计基于完整执行整轮周期。',
    };
  }
  return null;
}

/* ─────────────────────────────────────────
   导入码编解码（无服务器方案）

   格式（逗号分隔，base64url 编码）：
   persona, base_pct, signal_pct, extreme_pct,
   freq(w/b), base_pool_entry_score,
   normal_cd, accel_cd, quasi_cd, extreme_cd, max_single_pct
───────────────────────────────────────── */

function encodeImportCode(personaKey, strategy) {
  var csv = [
    personaKey,
    strategy.base_bullet_pct,
    strategy.signal_bullet_pct,
    strategy.extreme_bullet_pct,
    strategy.dca_frequency === 'weekly' ? 'w' : 'b',
    strategy.base_pool_entry_score,
    strategy.normal_signal_cooldown_days,
    strategy.accel_signal_cooldown_days,
    strategy.quasi_extreme_cooldown_days,
    strategy.extreme_signal_cooldown_days,
    strategy.max_single_position_pct,
    strategy.signal_score_threshold,
  ].join(',');
  return btoa(csv).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeImportCode(code) {
  try {
    var b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var parts = atob(b64).split(',');
    if (parts.length < 11) return null;
    return {
      persona: parts[0],
      strategy: {
        base_bullet_pct:              +parts[1],
        signal_bullet_pct:            +parts[2],
        extreme_bullet_pct:           +parts[3],
        dca_frequency:                parts[4] === 'w' ? 'weekly' : 'biweekly',
        base_pool_entry_score:        +parts[5],
        normal_signal_cooldown_days:  +parts[6],
        accel_signal_cooldown_days:   +parts[7],
        quasi_extreme_cooldown_days:  +parts[8],
        extreme_signal_cooldown_days: +parts[9],
        max_single_position_pct:      +parts[10],
        signal_score_threshold:       parts[11] ? +parts[11] : 28,
      },
    };
  } catch (e) {
    return null;
  }
}

/* ─────────────────────────────────────────
   动态窗口估算
───────────────────────────────────────── */

/**
 * 分阈值估算市场在各关键分数以下的剩余月数
 *
 * 时钟：score 首次跌破 45 以来的月数（monthsBelowEntry），由调用方从
 * signals-feed.json 的 undervalued_since 字段计算得到。
 *
 * 两个维度：
 *   A. 进入低估区的月数 → 估算已用进度（历史 below-45 窗口平均约 10 个月）
 *   B. 当前分数位置 → 微调（接近退出阈值 45 = 快出来了）
 *
 * 历史基准（3 轮熊市平均 below-45 窗口内的时长）：
 *   ≤30: 8月 | ≤28: 7月 | ≤25: 5月 | ≤22: 4月 | ≤17: 2月
 *
 * @param {number} cycleScore      当前周期分 0-100
 * @param {number} monthsBelowEntry score ≤ 45 以来的月数
 * @returns {{ below30, below28, below25, below22, below17 }} 各阈值估算剩余月数
 */
function estimateWindowsByThreshold(cycleScore, monthsBelowEntry) {
  // 维度 A：进入低估区的月数 → 已用进度
  var pct;
  if      (monthsBelowEntry < 2)  pct = 0.10;
  else if (monthsBelowEntry < 4)  pct = 0.25;
  else if (monthsBelowEntry < 6)  pct = 0.40;
  else if (monthsBelowEntry < 8)  pct = 0.55;
  else if (monthsBelowEntry < 10) pct = 0.70;
  else if (monthsBelowEntry < 12) pct = 0.82;
  else                            pct = 0.90;

  // 维度 B：当前分数微调（接近退出阈值 45 → 进度前移）
  if      (cycleScore >= 38) pct = Math.min(0.90, pct + 0.10);
  else if (cycleScore >= 32) pct = Math.min(0.87, pct + 0.05);

  var rem = 1 - pct;

  // 概率折扣：当前分数 > 阈值时，市场需进一步下跌才能进入该区间
  var p30 = cycleScore <= 30 ? 1.00 : (cycleScore <= 40 ? 0.85 : 0.50);
  var p28 = cycleScore <= 28 ? 1.00 : (cycleScore <= 35 ? 0.80 : 0.40);
  var p25 = cycleScore <= 25 ? 1.00 : (cycleScore <= 28 ? 0.75 : (cycleScore <= 35 ? 0.55 : 0.25));
  var p22 = cycleScore <= 22 ? 1.00 : (cycleScore <= 28 ? 0.70 : (cycleScore <= 35 ? 0.45 : 0.20));
  var p17 = cycleScore <= 17 ? 1.00 : (cycleScore <= 22 ? 0.65 : (cycleScore <= 28 ? 0.45 : 0.15));

  // 当前已在该区间内 → 至少保留 1 个月（防止紧迫度计算崩溃）
  return {
    below30: Math.max(cycleScore <= 30 ? 1 : 0, Math.round(8 * rem * p30)),
    below28: Math.max(cycleScore <= 28 ? 1 : 0, Math.round(7 * rem * p28)),
    below25: Math.max(cycleScore <= 25 ? 1 : 0, Math.round(5 * rem * p25)),
    below22: Math.max(cycleScore <= 22 ? 1 : 0, Math.round(4 * rem * p22)),
    below17: Math.max(cycleScore <= 17 ? 1 : 0, Math.round(2 * rem * p17)),
  };
}

/**
 * 紧迫度乘数：8个月 = 1.0×（历史平均基准），剩余越短乘数越大
 * @param {number} remainingMonths
 * @returns {number} 乘数 [0.5, 2.0]
 */
function calcUrgencyMultiplier(remainingMonths) {
  var raw = 8 / Math.max(remainingMonths, 1);
  return Math.round(Math.max(0.5, Math.min(2.0, raw)) * 100) / 100;
}

/**
 * 基础池总批次数（替代硬编码的 getTimesPerYear）
 * @param {object}      strategy
 * @param {number|null} remainingMonths
 * @returns {number}
 */
function calcBasePeriods(strategy, windowsOrMonths) {
  var months;
  if (windowsOrMonths && typeof windowsOrMonths === 'object' && typeof windowsOrMonths.below28 === 'number') {
    months = windowsOrMonths.below28;
  } else if (typeof windowsOrMonths === 'number' && windowsOrMonths > 0) {
    months = windowsOrMonths;
  } else {
    months = 8;
  }
  var periodsPerMonth = strategy.dca_frequency === 'weekly' ? 4 : 2;
  return Math.max(1, Math.round(months * periodsPerMonth));
}
