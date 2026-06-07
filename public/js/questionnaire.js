/**
 * questionnaire.js — 问卷逻辑与 5 维评分
 *
 * 15 道题，覆盖 5 个投资者维度：
 *   fund_nature    资金性质（2 题）
 *   resilience     心理韧性（6 题，含 2 题行为历史）
 *   knowledge      知识深度（3 题）
 *   fund_structure 资金时间结构（2 题）
 *   exit_horizon   退出时间线（2 题）
 *
 * 每题选项带 score（1–5），维度得分 = 维度内各题 score 的平均值（四舍五入到整数）。
 * 完成后将 5 维分数写入 localStorage 并跳转至 persona.html。
 */

/* ═══════════════════════════════════════
   题库
═══════════════════════════════════════ */
const QUESTIONS = [
  /* ── 资金性质 ── */
  {
    id: 1, dimension: 'fund_nature', section: '资金性质', sectionClass: 'fund-nature',
    scenario: false,
    text: '你这次计划用于定投的资金，属于哪种性质？',
    options: [
      { text: '这是我主要储蓄的一大部分，绝对亏不起', score: 1 },
      { text: '这是一部分储蓄，亏了会很难受但能承受', score: 2 },
      { text: '这是专门留出的风险投资资金，亏了可接受', score: 3 },
      { text: '这是完全可以归零的额外闲钱', score: 5 },
    ]
  },
  {
    id: 2, dimension: 'fund_nature', section: '资金性质', sectionClass: 'fund-nature',
    scenario: false,
    text: '如果这笔投资账面亏损 70%，对你日常生活的影响是？',
    options: [
      { text: '会严重影响，可能需要变卖资产维持生活', score: 1 },
      { text: '会比较紧张，需要压缩日常开销', score: 2 },
      { text: '有压力，但基本生活完全不受影响', score: 3 },
      { text: '几乎没影响，本来就是可以不要的钱', score: 5 },
    ]
  },

  /* ── 心理韧性（情景题） ── */
  {
    id: 3, dimension: 'resilience', section: '心理韧性', sectionClass: 'resilience',
    scenario: true,
    text: '你的 BTC 仓位在买入后 3 个月亏损了 40%，你最可能的第一反应是？',
    options: [
      { text: '感到恐慌，认真考虑止损离场', score: 1 },
      { text: '感到很不安，但强迫自己继续等待', score: 2 },
      { text: '感到难受，但理性上清楚这可能是机会', score: 4 },
      { text: '感到兴奋，考虑趁机加仓', score: 5 },
    ]
  },
  {
    id: 4, dimension: 'resilience', section: '心理韧性', sectionClass: 'resilience',
    scenario: true,
    text: '你收到"极端底部信号"提醒，此时账户浮亏已达 50%，你会？',
    options: [
      { text: '忽略提醒，不想再看账户', score: 1 },
      { text: '看了提醒，但心理上无法执行买入', score: 2 },
      { text: '会按计划执行，但内心非常挣扎', score: 4 },
      { text: '按计划执行，甚至希望信号再多一些', score: 5 },
    ]
  },
  {
    id: 5, dimension: 'resilience', section: '心理韧性', sectionClass: 'resilience',
    scenario: false,
    text: '在过去的投资经历中，遇到较大亏损时，你通常会？',
    options: [
      { text: '快速止损，无法忍受持续下跌', score: 1 },
      { text: '忍住不动，但会频繁刷新账户', score: 2 },
      { text: '调低部分仓位，保留一部分等待反弹', score: 3 },
      { text: '保持或增加仓位，逢跌加仓', score: 5 },
      { text: '没有过相关经历', score: 3, skip: true },
    ]
  },
  {
    id: 6, dimension: 'resilience', section: '心理韧性', sectionClass: 'resilience',
    scenario: false,
    text: '对于一个长期看好的投资，你能接受的最大账面亏损是多少？',
    options: [
      { text: '超过 20% 就难以忍受', score: 1 },
      { text: '可以接受 20–40% 的亏损', score: 2 },
      { text: '可以接受 40–60% 的亏损', score: 3 },
      { text: '可以接受 60–80% 的亏损', score: 4 },
      { text: '即使亏损 80%+ 也能坚持', score: 5 },
    ]
  },

  /* ── 知识深度 ── */
  {
    id: 7, dimension: 'knowledge', section: '知识深度', sectionClass: 'knowledge',
    scenario: false,
    text: '你对 MVRV、长期持有者供应量等链上分析指标的了解程度？',
    options: [
      { text: '完全没听说过', score: 1 },
      { text: '听说过，但不懂具体含义', score: 2 },
      { text: '了解基本概念，能读懂简单解释', score: 3 },
      { text: '比较熟悉，能独立解读数据', score: 4 },
      { text: '非常了解，可以做深度分析', score: 5 },
    ]
  },
  {
    id: 8, dimension: 'knowledge', section: '知识深度', sectionClass: 'knowledge',
    scenario: false,
    text: '你跟踪、研究 BTC 市场多长时间了？',
    options: [
      { text: '不到 6 个月，刚入场', score: 1 },
      { text: '6 个月到 1 年', score: 2 },
      { text: '1 到 3 年', score: 3 },
      { text: '3 到 5 年，经历过一个完整周期', score: 4 },
      { text: '5 年以上，经历过多个完整周期', score: 5 },
    ]
  },
  {
    id: 9, dimension: 'knowledge', section: '知识深度', sectionClass: 'knowledge',
    scenario: false,
    text: '以下哪种描述最符合你现在对"熊市定投"的认识？',
    options: [
      { text: '越跌越亏，应该等反弹后再买', score: 1 },
      { text: '理论上知道应该买，但很难克服恐惧', score: 2 },
      { text: '理解其中逻辑，愿意按计划执行', score: 3 },
      { text: '清楚底部积累机制，会主动在下跌时加仓', score: 4 },
      { text: '深度理解周期规律，有完整的建仓和退出计划', score: 5 },
    ]
  },

  /* ── 资金时间结构 ── */
  {
    id: 10, dimension: 'fund_structure', section: '资金时间结构', sectionClass: 'fund-structure',
    scenario: false,
    text: '你打算如何投入这笔定投资金？',
    options: [
      { text: '一次性投入所有或大部分资金', score: 1 },
      { text: '用现有储蓄分批投入，之后不再追加', score: 2 },
      { text: '以现有储蓄为主，偶尔从收入中追加', score: 3 },
      { text: '每月固定从收入中划出一部分持续投入', score: 4 },
      { text: '储蓄率高，可以长期持续追加较大金额', score: 5 },
    ]
  },
  {
    id: 11, dimension: 'fund_structure', section: '资金时间结构', sectionClass: 'fund-structure',
    scenario: false,
    text: '你的总定投预算大约相当于几个月的税后月收入？',
    options: [
      { text: '超过 24 个月（很重的仓位）', score: 1 },
      { text: '12 到 24 个月', score: 2 },
      { text: '6 到 12 个月', score: 3 },
      { text: '3 到 6 个月', score: 4 },
      { text: '不到 3 个月（真正的闲钱）', score: 5 },
    ]
  },

  /* ── 退出时间线 ── */
  {
    id: 12, dimension: 'exit_horizon', section: '退出时间线', sectionClass: 'exit-horizon',
    scenario: false,
    text: '你大致希望在什么时间段开始考虑退出部分仓位？',
    options: [
      { text: '1 年内，我的周期偏短', score: 1 },
      { text: '1 到 2 年', score: 2 },
      { text: '2 到 3 年（下一个牛市高峰附近）', score: 3 },
      { text: '3 到 5 年，不着急，等大级别机会', score: 4 },
      { text: '5 年以上，超长期持有', score: 5 },
    ]
  },
  {
    id: 13, dimension: 'exit_horizon', section: '退出时间线', sectionClass: 'exit-horizon',
    scenario: false,
    text: '如果 BTC 在未来 3 年内涨了 10 倍，你最可能的计划是？',
    options: [
      { text: '全部卖出，彻底变现', score: 1 },
      { text: '卖出大部分（70%+），保留少量', score: 2 },
      { text: '分批卖出，保持一定比例长期仓位', score: 3 },
      { text: '只卖出小部分用于生活，大部分继续持有', score: 4 },
      { text: '基本不卖，继续等待更高的牛市高峰', score: 5 },
    ]
  },

  /* ── 行为历史（归入心理韧性计分） ── */
  {
    id: 14, dimension: 'resilience', section: '历史行为', sectionClass: 'history',
    scenario: false,
    text: '在 2022 年加密熊市（BTC 从约 69000 跌至约 16000），你的实际行为是？',
    options: [
      { text: '我被止损了，或在低位卖出过', score: 1 },
      { text: '忍住没卖，但那段时间极度煎熬', score: 2 },
      { text: '保持了大部分仓位，基本按计划执行', score: 4 },
      { text: '越跌越买，趁熊市加仓了', score: 5 },
      { text: '那时候我还没入场', score: 3, skip: true },
    ]
  },
  {
    id: 15, dimension: 'resilience', section: '历史行为', sectionClass: 'history',
    scenario: false,
    text: '你历史上最严重的一次投资亏损，给你留下的主要影响是？',
    options: [
      { text: '对高风险投资产生了持续的恐惧感', score: 1 },
      { text: '变得更加保守，更难接受账面波动', score: 2 },
      { text: '认识了风险，但没有根本改变投资观', score: 3 },
      { text: '成了重要学习经历，让我更清楚地看到机会', score: 4 },
      { text: '没有显著影响，或从未有过大亏损', score: 3, skip: true },
    ]
  },
];

/* ═══════════════════════════════════════
   状态
═══════════════════════════════════════ */
let currentIndex = 0;
const answers = new Array(QUESTIONS.length).fill(null);

/* ═══════════════════════════════════════
   DOM 引用
═══════════════════════════════════════ */
const progressFill = document.getElementById('progressFill');
const qSectionTag  = document.getElementById('qSectionTag');
const qCounter     = document.getElementById('qCounter');
const qCard        = document.getElementById('qCard');
const qBackBtn     = document.getElementById('qBackBtn');
const qStage       = document.getElementById('qStage');
const qComplete    = document.getElementById('qComplete');

/* ═══════════════════════════════════════
   核心渲染
═══════════════════════════════════════ */
function renderQuestion(index, direction) {
  const q = QUESTIONS[index];

  /* 进度条 + 元信息 */
  progressFill.style.width = (index / QUESTIONS.length * 100) + '%';
  qSectionTag.textContent  = q.section;
  qSectionTag.className    = 'q-section-tag ' + q.sectionClass;
  qCounter.textContent     = (index + 1) + ' / ' + QUESTIONS.length;
  qBackBtn.disabled        = (index === 0);

  /* 构建 HTML */
  const scenarioTag = q.scenario
    ? '<div class="q-scenario-tag">⚡ 情景模拟</div>'
    : '';

  const optionsHTML = q.options.map((opt, i) => {
    const cls = [
      'q-option',
      opt.skip             ? 'opt-skip'  : '',
      answers[index] === i ? 'selected'  : '',
    ].filter(Boolean).join(' ');

    return `<div class="${cls}" data-idx="${i}">
      <div class="opt-circle"></div>
      <div class="opt-text">${opt.text}</div>
    </div>`;
  }).join('');

  /* 先将卡片移至进入方向的起点（不可见）*/
  qCard.style.transition = 'none';
  qCard.style.opacity    = '0';
  qCard.style.transform  = direction === 'back' ? 'translateX(-22px)' : 'translateX(22px)';
  qCard.innerHTML = scenarioTag +
    `<div class="q-text">${q.text}</div>` +
    `<div class="q-options">${optionsHTML}</div>`;

  /* 触发入场动画（两帧后确保 DOM 已更新）*/
  requestAnimationFrame(() => requestAnimationFrame(() => {
    qCard.style.transition = 'opacity 0.22s ease-out, transform 0.22s ease-out';
    qCard.style.opacity    = '1';
    qCard.style.transform  = 'translateX(0)';
  }));

  /* 绑定选项点击 */
  qCard.querySelectorAll('.q-option').forEach(el => {
    el.addEventListener('click', () => onSelect(index, +el.dataset.idx));
  });
}

/* ═══════════════════════════════════════
   选项点击
═══════════════════════════════════════ */
function onSelect(qIndex, optIndex) {
  answers[qIndex] = optIndex;
  saveProgress();

  /* 视觉反馈 */
  qCard.querySelectorAll('.q-option').forEach((el, i) => {
    el.classList.toggle('selected', i === optIndex);
    el.classList.toggle('dimmed',   i !== optIndex);
  });

  setTimeout(() => {
    if (qIndex < QUESTIONS.length - 1) {
      currentIndex = qIndex + 1;
      saveProgress();
      goTo(currentIndex, 'forward');
    } else {
      sessionStorage.removeItem('btc_dca_q_progress');
      finish();
    }
  }, 180);
}

/* ═══════════════════════════════════════
   题目切换（退场 → 渲染）
═══════════════════════════════════════ */
function goTo(index, direction) {
  qCard.style.transition = 'opacity 0.12s ease-in, transform 0.12s ease-in';
  qCard.style.opacity    = '0';
  qCard.style.transform  = direction === 'back' ? 'translateX(16px)' : 'translateX(-16px)';
  setTimeout(() => renderQuestion(index, direction), 130);
}

/* ═══════════════════════════════════════
   返回上一题
═══════════════════════════════════════ */
qBackBtn.addEventListener('click', () => {
  if (currentIndex > 0) {
    currentIndex--;
    saveProgress();
    goTo(currentIndex, 'back');
  }
});

/* ═══════════════════════════════════════
   计算 5 维得分
═══════════════════════════════════════ */
function computeScores() {
  const buckets = {
    fund_nature: [], resilience: [], knowledge: [],
    fund_structure: [], exit_horizon: [],
  };

  QUESTIONS.forEach((q, i) => {
    if (answers[i] !== null) {
      buckets[q.dimension].push(q.options[answers[i]].score);
    }
  });

  const result = {};
  for (const [dim, scores] of Object.entries(buckets)) {
    const avg = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 3;
    result[dim] = Math.max(1, Math.min(5, Math.round(avg)));
  }
  return result;
}

/* ═══════════════════════════════════════
   完成问卷
═══════════════════════════════════════ */
function finish() {
  /* 淡出题目区域 */
  qStage.style.transition  = 'opacity 0.3s';
  qStage.style.opacity     = '0';
  qBackBtn.style.display   = 'none';
  progressFill.style.width = '100%';

  setTimeout(() => {
    qStage.style.display = 'none';
    qComplete.classList.add('show');
  }, 300);

  const scores = computeScores();
  localStorage.setItem('btc_dca_scores',  JSON.stringify(scores));
  localStorage.setItem('btc_dca_answers', JSON.stringify(answers));

  /* 跳转到画像页 */
  setTimeout(() => {
    const p = new URLSearchParams({
      fn: scores.fund_nature,
      r:  scores.resilience,
      kn: scores.knowledge,
      fs: scores.fund_structure,
      eh: scores.exit_horizon,
    });
    window.location.href = 'persona.html?' + p.toString();
  }, 1800);
}

/* ═══════════════════════════════════════
   进度持久化（sessionStorage）
═══════════════════════════════════════ */
function saveProgress() {
  sessionStorage.setItem('btc_dca_q_progress',
    JSON.stringify({ idx: currentIndex, ans: answers }));
}

function restoreProgress() {
  try {
    const saved = sessionStorage.getItem('btc_dca_q_progress');
    if (!saved) return;
    const { idx, ans } = JSON.parse(saved);
    if (typeof idx === 'number' && Array.isArray(ans) && ans.length === QUESTIONS.length) {
      ans.forEach((v, i) => { answers[i] = v; });
      currentIndex = Math.min(idx, QUESTIONS.length - 1);
    }
  } catch (_) { /* ignore corrupt data */ }
}

/* ═══════════════════════════════════════
   初始化
═══════════════════════════════════════ */
restoreProgress();
renderQuestion(currentIndex, 'forward');
