/**
 * utils.js — 公共工具函数
 */

/**
 * 根据周期分数返回颜色变量名
 * @param {number} score 0-100
 * @returns {string} CSS 变量值
 */
function scoreColor(score) {
  if (score < 25) return 'var(--color-extreme-low)';
  if (score < 45) return 'var(--color-low)';
  if (score < 70) return 'var(--color-neutral)';
  if (score < 85) return 'var(--color-high)';
  return 'var(--color-extreme-high)';
}

/**
 * 根据周期分数返回阶段描述
 * @param {number} score
 * @returns {{ phase: string, desc: string }}
 */
function scorePhase(score) {
  if (score < 25) return { phase: '极端底部', desc: '链上信号极度超卖，历史上是最稀缺的建仓窗口' };
  if (score < 45) return { phase: '熊市积累', desc: '市场处于低估区间，适合分批定投持续布局' };
  if (score < 70) return { phase: '震荡中性', desc: '信号中性，维持常规基础定投节奏' };
  if (score < 85) return { phase: '高估预警', desc: '部分指标发出警示，建议放缓建仓节奏' };
  return { phase: '极度高估', desc: '链上信号普遍过热，建议暂停新建仓位' };
}

/**
 * 根据百分位返回指标颜色
 * 百分位越低（越冷）越绿，越高（越热）越红
 * @param {number} pct 0-100
 * @returns {string} CSS 变量值
 */
function percentileColor(pct) {
  if (pct < 25) return 'var(--color-extreme-low)';
  if (pct < 45) return 'var(--color-low)';
  if (pct < 65) return 'var(--color-neutral)';
  if (pct < 80) return 'var(--color-high)';
  return 'var(--color-extreme-high)';
}

/**
 * 格式化日期为"X天前"或"今天"
 * @param {string} dateStr YYYY-MM-DD
 * @returns {string}
 */
function relativeDate(dateStr) {
  const now = new Date();
  const d = new Date(dateStr);
  const diffMs = now - d;
  const diffH = diffMs / (1000 * 60 * 60);
  if (diffH < 24) return '今天更新';
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return '1 天前更新';
  return `${diffD} 天前更新`;
}

/**
 * 判断信号数据是否过期（超 48 小时）
 * @param {string} updatedAt YYYY-MM-DD
 * @returns {boolean}
 */
function isDataStale(updatedAt) {
  const d = new Date(updatedAt);
  const diffH = (Date.now() - d.getTime()) / (1000 * 60 * 60);
  return diffH > 48;
}

/**
 * 格式化 BTC 价格，加千分位
 * @param {number} price
 * @returns {string}
 */
function formatPrice(price) {
  return '$' + price.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/**
 * 把 0-100 分数映射到进度条 left% 位置
 * @param {number} score
 * @returns {string} e.g. "42%"
 */
function scoreToPosition(score) {
  return Math.max(2, Math.min(98, score)) + '%';
}
