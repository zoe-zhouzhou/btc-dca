# BTC 智能定投 — 项目上下文

> 每次新 session 开始时请先读完本文件，再开始工作。
> 完成一个 session 后，**更新下方的"当前进度"和"已知问题"部分**。

---

## 产品概述

帮助普通投资者在 BTC 熊市中理性建仓。核心是：不预测价格，用链上信号驱动定投决策，结合用户画像定制个性化策略。

完整产品文档见：[BTC智能定投产品文档_v1.1.md](./BTC智能定投产品文档_v1.1.md)

---

## 技术栈

| 模块 | 技术 |
|------|------|
| Web 前端 | 纯静态 HTML/CSS/JS，无框架，Chart.js 可视化 |
| 后端 | **无**（导入码为本地 base64url 编码，无需服务器） |
| 部署 | 前端 GitHub Pages（完全静态） |
| 信号 Feed | GitHub Actions 每日拉取 → `docs/signals-feed.json` |

---

## 项目目录结构

```
BTCDCA/
├── CLAUDE.md                        # 本文件
├── BTC智能定投产品文档_v1.1.md        # 完整产品文档
├── docs/                          # 前端静态文件
│   ├── index.html                   # 入口页（周期看板）
│   ├── questionnaire.html           # 问卷页
│   ├── persona.html                 # 画像展示页
│   ├── strategy.html                # 策略生成页
│   ├── backtest.html                # 历史回测页
│   ├── install.html                 # 导入码 + Skill 安装引导页
│   ├── signals-feed.json            # 每日信号数据（GitHub Actions 维护）
│   ├── css/
│   └── js/
│       ├── signals.js               # 信号读取与周期分数计算
│       ├── questionnaire.js         # 问卷逻辑与评分
│       ├── persona.js               # 画像分类（欧氏距离匹配）
│       ├── strategy.js              # 策略生成逻辑（含 encodeImportCode / decodeImportCode）
│       ├── backtest.js              # 回测引擎
│       └── utils.js                 # 公共工具函数
├── scripts/                         # GitHub Actions 脚本
│   └── fetch-signals.js             # 拉取链上数据，生成 signals-feed.json
└── .github/
    └── workflows/
        └── fetch-signals.yml        # 每日 8:00 触发
```

---

## 核心数据结构

### signals-feed.json（信号数据）

```json
{
  "updated_at": "2026-04-05",
  "mvrv_z": { "value": 1.1346, "normalized_score": 16 },
  "puell_multiple": { "value": 0.6, "normalized_score": 12 },
  "nupl": { "value": -0.05, "normalized_score": 22 },
  "exchange_reserves": { "trend": "decreasing", "normalized_score": 18 },
  "fgi": { "value": 9, "label": "Extreme Fear", "normalized_score": 9 },
  "funding_rate": { "value": -0.02, "trend": "negative", "normalized_score": 5 },
  "halving_cycle": { "months_since_halving": 8, "normalized_score": 15 },
  "etf_flow": { "7d_avg_usd_m": -120, "normalized_score": 20 },
  "cycle_score": 27,
  "degraded": false,
  "degraded_reason": null
}
```

### 服务端策略配置（7天TTL）

```json
{
  "persona": "calm_hunter",
  "scores": { "fund_nature": 5, "resilience": 5, "knowledge": 5, "fund_structure": 4, "exit_horizon": 4 },
  "entry_threshold": 50,
  "strategy": {
    "base_bullet_pct": 15,
    "signal_bullet_pct": 30,
    "extreme_bullet_pct": 55,
    "dca_frequency": "weekly",
    "base_pool_entry_score": 35,
    "normal_signal_cooldown_days": 7,
    "accel_signal_cooldown_days": 10,
    "quasi_extreme_cooldown_days": 7,
    "extreme_signal_cooldown_days": 7,
    "max_single_position_pct": 25
  }
}
```

---

## 关键业务逻辑

### 周期分数算法（8指标，分数越低越便宜）

| 指标 | 权重 | 数据来源 |
|------|------|---------|
| MVRV-Z Score | 25% | Glassnode → signals-feed.json（备用：CoinMetrics `CapMVRVCur`） |
| Puell Multiple | 20% | Glassnode → signals-feed.json（备用：LookIntoBitcoin） |
| NUPL / SOPR | 15% | Glassnode → signals-feed.json（备用：LookIntoBitcoin） |
| 交易所储备量 | 10% | Glassnode → signals-feed.json（备用：CryptoQuant） |
| 恐慌贪婪指数 | 15% | alternative.me → signals-feed.json |
| 资金费率信号 | 5% | Binance/Bybit 公开 API → signals-feed.json |
| 减半周期位置 | 5% | 本地计算（根据减半日期） |
| ETF 资金流向 | 5% | GitHub Actions → signals-feed.json |

权重为经验权重+回测验证，非数学最优。每个指标归一化为 0-100（低=底部，高=顶部）。

**评分区间**：0-25 极端底部 / 25-45 熊市积累 / 45-70 震荡中性 / 70-100 高估预警

**降级模式**：Glassnode 不可用时，用 FGI + 资金费率 + 减半周期位置兜底，界面显示橙色警告，暂停信号型定投。

### 信号触发四级体系

> **权威参考：`public/js/signals.js`（detectSignalLevel）+ `strategy.js`（generateStrategy / calcSignalExec）**

| 级别 | 触发条件（全部满足） | 动作 | 冷静期 |
|------|-------------------|----|------|
| 普通信号 | 周期分 ≤28 · 8指标中≥5项归一化分≤40 · MVRV ratio < 1.5 | 信号池 × **6%**，单次执行 | r≥4: 7天 / r≥3: 8天 / r<3: 10天 |
| 加速信号 | 周期分 ≤30 · ≥7项归一化分≤25 · MVRV ratio < 1.2 · FGI < 15 | 信号池 × **10%**，单次执行 | r≥4: 10天 / r≥3: 12天 / r<3: 14天 |
| 准极端信号 | 周期分 ≤22 · MVRV ratio < 1.0 · NUPL < 0 · FGI < 12 **或** 周期分 ≤20 · FGI < 12（ETF纪元备选） | 极端池 × **12%**，单次执行 | **7天**（所有画像固定） |
| 极端底部信号 | 周期分 ≤17 · MVRV ratio < 0.85 · FGI < 7 · Puell < 0.5 **或** 周期分 ≤15 · FGI < 7 · Puell < 0.5（ETF纪元备选） | 极端池 × **20%**，单次执行 | **7天**（所有画像固定） |

**关键设计决策：**
- 极端信号冷静期固定7天（底部窗口短，需快速部署弹药）
- 准极端与极端底部**共用**极端池（条件嵌套，系统取最高级触发，不重复消耗）
- 信号池设计覆盖约16次普通信号触发（6% × 16 ≈ 96%）；极端池设计覆盖约8次准极端（12%×8=96%）或5次极端底部（20%×5=100%）
- 基础池按**8个月**底部窗口摊算（weekly: 34批，biweekly: 17批）；触发门槛 score ≤ min(28, entry_threshold) = **28**，与普通信号门槛对齐
- ETF纪元备选路径：MVRV-Z 因机构买盘结构性抬底，准极端/极端底部添加 FGI 驱动备选路径（见 signals.js detectSignalLevel）
- 普通信号 / 基础池触发门槛调整至 score ≤ **28**（熊市积累下段），避免在市场未进入极端前耗尽弹药

### 三档停止逻辑（半对称）

| 周期分数 | 信号型 | 时间型 | 计划状态 |
|---------|--------|--------|---------|
| 0–45 | ✅ | ✅ | 活跃 |
| 45–55* | ❌ | ✅ | 活跃（惯性缓冲） |
| 55–70* | ❌ | ❌ | 暂停（可自动恢复） |
| ≥ 70 | ❌ | ❌ | 终止（需重新评估） |

*时间型停止阈值因画像浮动：激进型60，标准型55，保守型50，极保守型45。

### 12种用户画像

`calm_hunter` / `silent_whale` / `determined_builder` / `curious_explorer` /
`precise_guardian` / `cautious_observer` / `faithful_believer` / `trend_follower` /
`anxious_participant` / `confused_entrant` / `allin_idealist` / `conservative_watcher`

分类方法：基于5维评分做欧氏距离最近邻匹配。入场门槛范围 ≤35（极保守）至 ≤50（激进），由综合风险承受度决定。

### 数据源容错

- `signals-feed.json` 的 `updated_at` 超过 48 小时 → 前端显示橙色警告，暂停信号型定投
- Glassnode 不可用 → `degraded: true`，切换备用数据源
- GitHub Actions 失败 → 发送告警通知

---

## 开发分 Session 计划

| Session | 内容 | 状态 |
|---------|------|------|
| 1 | 项目初始化 + 入口页（周期看板） | ✅ 已完成 |
| 2 | 问卷模块（15题 + 5维评分逻辑） | ✅ 已完成 |
| 3 | 画像展示（12类 + 默认宣言模板 + Claude API 可选生成） | ✅ 已完成 |
| 4 | 策略生成页面（三子弹框架 + 四级信号展示） | ✅ 已完成 |
| 5 | 历史回测引擎 + 可视化（含2014-15年数据 + 等权重对照） | ✅ 已完成 |
| 6 | 后端：导入码生成/读取 API（Node.js + Upstash Redis） | ✅ 已完成 |
| 7 | Skill：安装 + 信号检测 + 推送 + 执行记录（按 BTC定投Skill产品文档.md） | ✅ 已完成 |
| 8 | 联调 + 测试 + 部署（GitHub Pages + GitHub Actions）| ✅ 已完成 |

**当前进度**：Session 1–8 全部完成，项目已具备 GitHub Pages 部署条件。
**补充**：
- 入口页（index.html）已按 v1.2 产品文档升级为 8 指标体系（周期分数、signals-feed.json、signals.js 同步更新）。
- 全站导航栏已修复并统一（见 Session 8.x）。
- Session 8 完成了 GitHub Actions 数据采集脚本、SKILL.md 解码脚本 Bug 修复、完整脚本链联调验证。

### Session 7.x 导入码架构重构（无后端方案）

**背景：** 导入码原设计依赖 Express + Upstash Redis 后端，部署繁琐且有服务可用性风险。

**架构变更：** 完全去除后端，导入码直接用 base64url 编码策略参数：
- 格式：`persona,entry_threshold,base_pct,signal_pct,extreme_pct,freq(w/b),base_pool_entry_score,normal_cd,accel_cd,quasi_cd,extreme_cd,max_single_pct` → base64url
- 编码/解码函数在 `public/js/strategy.js`（`encodeImportCode` / `decodeImportCode`）
- SKILL.md Step 1 改为本地 Node.js 解码（无 curl 网络请求）

**删除文件：** `server/`（整个目录）、`public/js/config.js`（API base URL，不再需要）

**UX 变更：** strategy.html「安装 Skill」按钮直接编码并跳转 install.html；install.html widget 嵌入 Step 2 内，支持三路径初始化：URL 参数 → 本地解码 / localStorage 有数据 → 自动生成 / 无数据 → 引导去问卷页。

---

## 当前已知问题 / 待决策

### 持久状态约定

- 问卷进度通过 `sessionStorage` 保存，可恢复中断的作答进度。
- 得分同时写入 `localStorage`（key: `btc_dca_scores`）和 URL 参数，persona.html 两者均可读取。
- persona.html 完成后将画像 key 写入 `localStorage`（key: `btc_dca_persona`），CTA 跳转 strategy.html 时携带 `?persona=KEY&fn=N&r=N&kn=N&fs=N&eh=N`。
- 宣言本地存储 key 格式：`btc_dca_declaration_<personaKey>`，用户编辑后覆盖默认模板。
- Claude API 直连使用 `anthropic-dangerous-direct-browser-access: true` header，调用 claude-haiku-4-5-20251001，Token 由用户承担。
- strategy.html 无参数时跳转 questionnaire.html。

### CSS 规范

- `strategy.css` 和 `persona.css` 均已改用 `@import '../styles/design-system.css'`，不再内联变量。
- `questionnaire.css` 和 `css/style.css` 仍是内联变量写法，**后续不必改**（已可用）。
- 新增页面统一 `@import '../styles/design-system.css'`。

### 导航栏实现规范（重要）

**所有页面的 `<header>` / `<nav>` / 导航链接均使用内联 `style=""` 属性，不依赖任何 CSS 类。** 原因：设计系统通过 `@import` 加载，在本地 `file://` 环境下存在加载时序不确定性，CSS 类方案会导致某些页面导航渲染不完整。

内联样式值（与设计系统 token 一致）：
- `<header>`：`display:flex;align-items:center;justify-content:space-between;height:52px`
- `<nav>`：`display:flex;background:#e7e3db;border-radius:6px;padding:3px;gap:2px;flex-shrink:0`
- 非激活 `<a>`：`font-size:12px;font-weight:500;color:#7c7870;text-decoration:none;padding:4px 6px;border-radius:4px;white-space:nowrap`
- 激活 `<a>`：同上 + `color:#1c1c1e;background:#f0ede8;box-shadow:0 1px 3px rgba(0,0,0,.08)`
- logo `<a>`：`display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;color:#1c1c1e;text-decoration:none;letter-spacing:-0.1px`

**修改导航时**：直接编辑各 HTML 文件的 `<header>` 块，不要改 CSS 文件的 `.nav` 规则（CSS 类保留仅为兼容设计系统其他样式）。

### 策略生成算法

- 综合风险承受度 = (fn×2 + r×2 + fs + eh) / 7，映射到三子弹比例、入场门槛、冷静期、单次仓位上限。
- 具体映射区间见 `public/js/strategy.js` 的 `generateStrategy()` 函数。

### 画像数据结构（已更新）

`PERSONAS[key]` 中新增了两个字段，旧字段 `blindspot`（单数）已替换：

```js
{
  strengths:  string[],   // 3条，绿色 bullet
  blindspots: string[],   // 2条，琥珀色 bullet（原 blindspot 单条已废弃）
  tension:    string|null,// 内在张力说明；无矛盾的画像为 null
  // ...其他字段不变
}
```

`dimInfo(key, score)` 返回 `{ label, note?, barColor, dimColor }`，给各维度提供语义标签和进度条颜色。
`getDimTags(scores)` 取分数最高的4个维度语义标签，用于画像页头部 chips。

### 遗留问题

- `persona.css` 的 `.p-avatar` 目前用内联 SVG 硬编码了一个通用人形图标，12种画像共用同一头像，**后续可按 persona 类型换不同颜色/图标**。
- 五维度网格在极窄屏（< 320px）可能挤压，实际影响机型极少，暂不处理。

---

## 下次从哪里继续

**项目完成，待部署。** 下一步只需在 GitHub 上完成以下配置：

1. **创建 GitHub 仓库**，将整个 `BTCDCA/` 推送到 `main` 分支。
2. **GitHub Pages 设置**：仓库 Settings → Pages → Source 选 `main` 分支 `/public` 目录。
3. **GitHub Actions Secrets**：仓库 Settings → Secrets → `GLASSNODE_API_KEY`（必须）、`CRYPTOQUANT_API_KEY`（可选）。
4. **手动触发一次 workflow**：Actions → Fetch BTC Signals → Run workflow，验证 signals-feed.json 更新成功。
5. **更新 Skill 配置中的 signals_feed_url**：`install.html` 和 `btc-dca-skill/scripts/fetch-signals.js` 中的 URL 替换为实际 GitHub Pages 地址。

### Session 8 完成情况（2026-06-06）

**新增文件：**
- `scripts/fetch-signals.js`：GitHub Actions 每日数据采集脚本，拉取 Glassnode / FGI / Binance / ETF 数据，支持降级模式，写入 `docs/signals-feed.json`
- `.github/workflows/fetch-signals.yml`：每日 UTC 00:00（北京 08:00）触发，支持 `workflow_dispatch` 手动触发，有变更才 commit

**Bug 修复：**
- `btc-dca-skill/SKILL.md`：Step 1 解码脚本由扁平写入改为嵌套 `strategy` 对象格式，与 `check-triggers.js` / `analyze.js` 期望格式一致
- `btc-dca-skill/SKILL.md`：skill name 从 `btc-dca` 改为 `btc-dca-skill`（与文件夹名一致）
- `btc-dca-skill/SKILL.md`："6位导入码"文案更新为实际 base64url 格式说明

**联调验证：**
- 完整脚本链（fetch-signals → check-triggers → deliver）本地联调通过
- 导入码编解码往返验证通过（strategy.js ↔ SKILL.md Node 脚本）
- log-trade.js、analyze.js 正常运行
- 前端 localStorage 传参链路验证：questionnaire → persona → strategy → install 均正确

### Session 6 完成情况

已实现：
- `server/package.json` + `server/.env.example` + `server/index.js` + `server/routes/code.js`
- POST `/api/code/generate`：白名单净化 → 生成 6 位码（字符集去除 0/O/1/I/L）→ Upstash Redis setex TTL=7天 → 返回 code + expires_at
- GET `/api/code/:code`：格式校验 → Redis get → 返回配置或 404
- `public/js/config.js`：本地 localhost:3000 / 生产 Railway URL 自动切换
- `public/strategy.html`：新增"八、生成策略导入码"section + 两个 CTA（回测 + 安装 Skill）
- `public/install.html` + `public/css/install.css`：导入码读取 → 策略预览 + 安装步骤引导

### Session 6.x 策略参数优化 + UI 精简（2026-04-29）

**策略参数重新标定：**
- 信号池：每次触发比例 10%→**8%**（普通）/ 15%→**12%**（加速），覆盖约 3 个月有效信号窗口
- 极端池：取消分批执行，改为单次；比例 33%/50%→**10%/15%**，覆盖 8–10 周底部窗口；准极端与极端底部共用极端池
- 基础池：摊算周期从 1 年改为 **6 个月**（后又调整为 8 个月，见下方 Session 6.y）
- 准极端冷静期：10天→**7天**；信号池冷静期按心理韧性 r 浮动（7/8/10天 普通；10/12/14天 加速）

**前端文案同步：**
- `strategy.html`：三池描述、renderSignalCard 执行说明全部更新，信号 badge 有预算时显示金额
- `install.html`：新增加速信号冷静期行，极端池冷静期统一标签
- `persona.js`：silent_whale 策略描述删除"分批执行"旧说法

**UI 精简：**
- ⑥ 账面大幅亏损时：3 张独立卡片 → 可折叠 `<details>` 行（单容器内）
- ⑦ 何时结束定投：每条移除描述文字，保留紧凑标签列表

**文档：**
- `12-personas-strategy.md`：全部 12 个画像的信号执行表、弹药耐久性分析更新至当前参数

### Session 6.y 基础池参数修正 + 信号数据更新（2026-04-30）

**问题背景：** 回测发现基础池在第一次信号触发之前就耗尽（6个月窗口 + 每周触发 = 26批，但 MVRV ratio < 1.5 及其他条件需要市场进一步下跌，可能需要 3-9 个月）。

**参数修正：**
- 基础池触发门槛：新增 `base_pool_entry_score = min(40, entry_threshold)`，要求 score ≤ 40 才开始基础定投（激进/标准画像延迟约 5–10 个周期分，避免过早消耗）
- 基础池窗口：从 6 个月改为 **8 个月**（周投 34 批，双周投 17 批），每批金额相应减小
- 信号数据：`signals-feed.json` 更新至 2026-04-29 实时数据（价格 $75,906，FGI 29，MVRV-Z 0.7624，周期分 29）
- 极端底部 MVRV-Z 阈值：`≤ -0.3` → `≤ -0.15`（ETF 机构化后本轮底部特征修正，2022年 -0.3 仅出现 3 天，本轮最低 +0.32）

**修改文件：** `strategy.js`（generateStrategy + calcBaseExec + getTimesPerYear）、`strategy.html`（基础池说明文案）、`install.html`（新增基础定投触发行）、`signals.js` + `strategy.js`（MVRV-Z 阈值）、`signals-feed.json`

### Session 6.z 三池策略重设计（2026-04-30）

**背景：** 对比 2018/2022 回测发现原策略极端池比例不足，底部最优买点弹药不够集中。ETF 机构化后本轮 MVRV-Z 可能永远不到 -0.15。

**参数调整：**
- 三池比例重设：极端池大幅加重；基础池减轻；信号池固定 30%
  - risk ≥ 4.0：20/35/45 → **15/30/55**
  - risk ≥ 3.5：25/35/40 → **20/30/50**
  - risk ≥ 2.5：30/35/35 → **25/30/45**
  - risk ≥ 1.8：40/35/25 → **35/30/35**
  - else：50/30/20 → **45/25/30**
- 信号执行比例：普通 8%→**6%**，加速 12%→**10%**；准极端 10%→**12%**，极端底部 15%→**20%**
- 基础池触发门槛：`min(40, entry)` → `min(35, entry)` → `min(28, entry)`（与普通信号门槛对齐，对所有画像等效 28）
- ETF纪元备选路径新增：准极端（周期分≤20 + FGI<12）、极端底部（周期分≤15 + FGI<7 + Puell<0.5）

**修改文件：** `strategy.js`（三池比例 + 执行比例 + base_pool_entry_score + calcSignalCapacity + evaluateAllSignalLevels）、`signals.js`（detectSignalLevel 新增 ETF 纪元备选路径）、`backtest.js`（执行金额常量 + detectSignalForBacktest）、`strategy.html`（百分比文案修正）

### Session 8.x 全站导航栏修复（2026-06-06）

**问题：** persona.html / strategy.html 导航栏持续显示不完整（缺少策略、Skill 等 tab），且与 index.html 样式不一致。多次 CSS 修复（直接写入 CSS 文件、`<style>` + `!important` 内联块）均无效，根本原因是 `@import` 时序在 `file://` 环境下不可靠，叠加浏览器缓存导致部分页面仍显示旧版本。

**修复方案：** 全部 6 个 HTML 页面（index / questionnaire / persona / strategy / install / backtest）的 `<header>` 块改为内联 `style=""` 属性，使用硬编码 hex 值，彻底脱离 CSS 加载依赖。

**修改文件：** `public/index.html`、`public/questionnaire.html`、`public/persona.html`、`public/strategy.html`、`public/install.html`、`public/backtest.html`（均只改 `<header>` 块，其余内容不变）

---

### Session 5 遗留事项

- `backtest.js` 中 MVRV 用价格百分位近似，与真实 MVRV 有偏差；历史 FGI 2018 年前为 null，用 50 填充
- `approxCycleScore` 是简化版，无 LTH 供应链上数据，用价格跌幅近似，回测精度有限
- Chart.js 买入事件点未在图上直接标注（散点层暂未加入，仅在下方列表展示）
- 若策略无买入（资金用尽或始终在高估区），图表仍可渲染，但买入列表为空

---

## 每次 Session 开始前的 Checklist

1. 读完本文件，确认当前 Session 编号和目标
2. 查看"当前已知问题"，了解上个 Session 的遗留事项
3. 开始工作前更新对应 Session 的状态为 🔄 进行中
4. Session 结束后更新状态为 ✅ 已完成，并填写遗留问题

---

## 设计规范

> 完整 CSS 变量和组件样式见 [`public/styles/design-system.css`](./public/styles/design-system.css)

### 设计气质

**专业但不冷漠，数据驱动但有温度。**
让普通用户看得懂，不让专业用户觉得幼稚。

参考来源：截图中展示的金融工具 UI（圆环评分、语义化卡片、奶油白背景）。

### 色彩

| 用途 | 变量 | 值 | 说明 |
|------|------|----|------|
| 页面背景 | `--bg` | `#f0ede8` | 暖奶油白，非纯白，减少视觉疲劳 |
| 卡片一级 | `--card` | `#e7e3db` | 比背景深，靠色彩层次区分，不用阴影 |
| 卡片二级 | `--card-2` | `#dedad1` | hover 态、嵌套卡片 |
| 主文字 | `--t1` | `#1c1c1e` | 近黑，标题和主数据 |
| 次文字 | `--t2` | `#7c7870` | 描述、说明 |
| 三级文字 | `--t3` | `#aeaaa4` | 标签、辅助、时间戳 |
| 低估/看多 | `--green` | `#1e7d50` | 状态文案和指示器 |
| 中性/观望 | `--amber` | `#a87108` | 状态文案和指示器 |
| 高估/看空 | `--red` | `#c43030` | 状态文案和指示器 |
| CTA 按钮 | `--cta-bg` | `#1c1c1e` | 页面唯一高对比行动按钮，黑底白字 |

**原则：状态色（绿/橙/红）只出现在数据值和指示器上，不作大面积装饰背景。**

### 字体

```
font-family: 'Noto Sans SC', -apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif;
```

- 数字使用 `font-variant-numeric: tabular-nums`，防止位数变化时跳动
- 数值类大字（17px+）配合 `letter-spacing: -0.3px` 至 `-1px` 收紧

### 圆角

| 用途 | 变量 | 值 |
|------|------|----|
| 卡片、按钮 | `--radius` | `14px` |
| 小卡片、警告条 | `--radius-sm` | `10px` |
| 标签、角标 | `--radius-xs` | `6px` |

### 核心组件原则

**指标卡片（`ind-card`）**：
- 顶部小灰标签 → 语义化彩色状态文案（不显示原始数字）→ 3px 进度条 → 说明文字
- 状态文案举例："低估区 · 约35分位"，而非"percentile: 35"

**信号卡片（`signal-card`）**：
- 使用 `<details>` 实现折叠，默认折叠只显示"X 项条件满足"
- 展开后列出每项条件，✓ 绿色已满足 / ○ 灰色未满足，附具体数值

**CTA 按钮**：
- 页面只有一个主行动按钮，黑底白字，`padding: 18px 22px`
- 右侧 `↗` 箭头，hover 时向右上位移

**警告条（`alert`）**：
- 默认 `display: none`，`.show` 时显示
- 左侧无色块，整体背景半透明，不抢眼

**骨架屏（`sk`）**：
- 加 `sk` class 即触发扫光动画，数据就位后移除该 class

### 文件结构规范

```
public/
├── styles/
│   └── design-system.css   ← 所有 CSS 变量 + 通用组件（新页面直接 @import）
├── css/
│   └── style.css           ← 页面级样式（import design-system，再写页面特有样式）
└── js/
    ├── utils.js             ← scoreColor / scorePhase / formatPrice 等纯函数
    └── signals.js           ← fetchSignals / computeCycleScore / detectSignalLevel
```

新增页面：`@import '../styles/design-system.css';` 然后只写页面差异样式。**Header/Nav 使用内联样式，见"导航栏实现规范"。**

---

## 注意事项

- **隐私原则**：用户的精确预算绝不上传服务器，仅存本地
- **服务端数据**：策略配置7天TTL后自动删除，不存个人信息
- **Claude API**：可选，所有LLM调用消耗用户自己的Token，不经过产品服务器
- **回测数据**：历史价格和FGI数据硬编码在前端JS中，不需要接口
- **移动优先**：所有前端页面 mobile-first 设计，最大宽度 480px
- **无框架**：前端不引入 React/Vue 等框架，保持纯静态可部署
