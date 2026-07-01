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

  // 基础池触发门槛：35 分（约等于 200dMA 跌破时对应的周期分水位）
  // 信号池保留严格条件（≤28 + 多指标共振），确保两池先后有序启动
  const baseBulletEntryScore = 35;

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
function calcBaseExec(amounts, strategy) {
  const periods = strategy.dca_frequency === 'weekly' ? 34 : 17;
  return Math.round(amounts.base / periods);
}

/**
 * 信号触发时单次执行金额
 * @param {{ signal, extreme }} amounts
 * @param {'normal'|'accel'|'quasi'|'extreme'} signalLevel
 * @returns {{ amount: number, batches: number, batchAmount: number }}
 */
function calcSignalExec(amounts, signalLevel) {
  switch (signalLevel) {
    case 'normal': {
      const a = Math.round(amounts.signal * 0.06);
      return { amount: a, batches: 1, batchAmount: a };
    }
    case 'accel': {
      const a = Math.round(amounts.signal * 0.10);
      return { amount: a, batches: 1, batchAmount: a };
    }
    case 'quasi': {
      const a = Math.round(amounts.extreme * 0.12);
      return { amount: a, batches: 1, batchAmount: a };
    }
    case 'extreme': {
      const a = Math.round(amounts.extreme * 0.20);
      return { amount: a, batches: 1, batchAmount: a };
    }
    default:
      return { amount: 0, batches: 1, batchAmount: 0 };
  }
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
function evaluateAllSignalLevels(data) {
  const score    = computeCycleScore(data);
  const mvrzVal  = data.mvrv_ratio?.value        ?? 999;
  const fgiVal   = data.fgi?.value              ?? 50;
  const puellVal = data.puell_multiple?.value   ?? 999;

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
        { text: '周期分 ≤ 28',              value: `当前 ${score}`,                          met: score <= 28 },
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
        { text: '周期分 ≤ 30',              value: `当前 ${score}`,                           met: score <= 30 },
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
      },
    };
  } catch (e) {
    return null;
  }
}
