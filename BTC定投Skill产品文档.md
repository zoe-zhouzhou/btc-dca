# BTC 智能定投 · Skill 产品文档

> OpenClaw 执行层 · 完整设计规范 · v1.0 · 2026
>
> 本文档专门描述 BTC 智能定投 Skill 的完整设计，供 Claude Code 实现 SKILL.md 和配套脚本使用。阅读前请先阅读主产品文档了解整体架构。

---

## 1. Skill 概览

### 1.1 定位

Skill 是产品的执行层，负责在用户本地持续运行，完成信号监控、提醒推送、执行记录、数据分析和策略管理。Web 端负责生成策略，Skill 负责执行策略。

### 1.2 运行环境

| 环境 | 推送能力 | 记录分析 | 数据存储 | 部署方式 |
|------|---------|---------|---------|---------|
| OpenClaw（v1 主力） | 原生支持，自动推送 | Claude 原生对话 | 用户本地 | git clone + 对话安装 |
| Claude Code（v2） | 需系统 crontab + Telegram | Claude 原生对话 | 用户本地 | git clone + 对话安装 |

### 1.3 文件结构

```
btc-dca-skill/
├── SKILL.md                # Skill 大脑，Agent 读取此文件执行所有逻辑
├── scripts/
│   ├── fetch-signals.js    # 拉取 signals-feed.json + Binance 实时数据
│   ├── check-triggers.js   # 对照策略判断是否触发
│   ├── deliver.js          # 推送逻辑（Telegram / stdout）
│   ├── log-trade.js        # 记录执行日志
│   └── analyze.js          # 分析当前定投状态
├── prompts/
│   ├── alert-triggered.md  # 触发提醒的文案模板
│   ├── alert-drawdown.md   # 浮亏提醒的文案模板
│   └── alert-skip.md       # 跳过提醒的文案模板
├── config/
│   └── default-thresholds.json  # 默认信号阈值（各画像类型）
└── package.json
```

> 所有用户数据存储在 `~/.btc-dca/` 目录，不在 Skill 目录内。Skill 目录只包含逻辑，数据和用户配置完全分离。

---

## 2. 安装流程（Onboarding）

参考 follow-builders 的对话式安装设计，全程通过对话完成，用户无需手动编辑任何配置文件。

### Step 0：平台检测

Skill 启动时第一件事是检测运行环境：

```bash
which openclaw 2>/dev/null && echo 'PLATFORM=openclaw' || echo 'PLATFORM=other'
```

- **OpenClaw**：使用 `openclaw cron add` 设置定时任务，推送通过 OpenClaw 渠道系统自动送达
- **其他（Claude Code 等）**：推送需要用户配置 Telegram Token，使用系统 crontab

将检测结果保存到 `~/.btc-dca/config.json` 的 `platform` 字段。

### Step 1：导入策略配置

检查 `~/.btc-dca/config.json` 是否存在且 `onboardingComplete` 为 true。若否，启动安装流程。

**Agent 说：**

> 你好！我是你的 BTC 智能定投助手。我会帮你监控市场信号、定时提醒你执行定投、记录每次买入，并分析你的建仓进展。
>
> 请先输入你在网页端生成的 6 位导入码，我来读取你的策略配置。

**用户输入导入码后，Agent 执行：**

```bash
# 从服务端拉取策略配置
curl https://api.btc-dca.app/config/{code} > ~/.btc-dca/strategy.json
```

拉取成功后，Agent 展示策略摘要并确认：

> 已读取你的策略配置：
>
> 画像类型：精算的守护者
> 定投频率：双周投（每月 1 日和 15 日）
> 子弹分配：基础池 35% / 信号池 30% / 极端池 35%
> 入场门槛：周期评分 ≤ 65 分
>
> 当前周期评分：27 分，已达入场条件。
>
> 这是你的策略吗？

### Step 2：补充本地信息

服务端配置不含隐私敏感信息，需要在本地补充两项：

**精确预算：**

> 还需要两个只存在你本地的信息：
>
> 1. 你的总预算是多少？（例如：200万）
>    这个数字只存在你的电脑上，不会上传。

**自我宣言：**

> 2. 这是根据你的画像为你生成的自我宣言，当账面亏损超过 50% 时我会展示给你看：
>
> 【AI 生成的个性化文案，根据画像类型和策略动态生成】
>
> 你可以直接确认，或者告诉我哪里需要修改。

将精确预算和自我宣言保存到 `~/.btc-dca/local.json`（不上传，不过服务端）。

### Step 3：配置推送渠道

**如果是 OpenClaw：**

> 你正在使用 OpenClaw，我可以直接推送到你当前的聊天频道。
>
> 应该推送到这个频道吗？还是推送到其他地方（Telegram / Discord / WhatsApp）？

让用户选择推送目标，然后获取 channel 和 target ID（参考 follow-builders 的 cron 配置逻辑）。

**如果是 Claude Code 或其他：**

> 你使用的不是 OpenClaw，我需要一个推送渠道才能主动提醒你。
>
> 推荐使用 Telegram：免费，设置约 5 分钟。
>
> 你有 Telegram 吗？

引导用户创建 Telegram Bot：

1. 打开 Telegram，搜索 @BotFather
2. 发送 `/newbot`，创建一个新 Bot
3. 复制 BotFather 给你的 Token
4. 打开你的新 Bot，发送任意消息（必须先发，否则无法收到推送）
5. 运行以下命令获取你的 Chat ID：

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['message']['chat']['id'])"
```

将 Token 和 Chat ID 保存到 `~/.btc-dca/.env`。

### Step 4：设置定时任务

**OpenClaw：**

```bash
openclaw cron add \
  --name "BTC 定投信号检测" \
  --cron "0 8 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "运行 btc-dca skill：执行 fetch-signals.js，检查触发条件，如有触发则推送提醒" \
  --announce \
  --channel <用户选择的渠道> \
  --to "<target ID>" \
  --exact
```

> ⚠️ 不要使用 `--channel last`，follow-builders 已验证此用法在多渠道配置下会失败。必须指定明确的渠道名称和 target ID。

**Claude Code / 其他：**

```bash
SKILL_DIR="$(pwd)"
(crontab -l 2>/dev/null; echo "0 8 * * * cd $SKILL_DIR/scripts && node fetch-signals.js 2>/dev/null | node check-triggers.js 2>/dev/null | node deliver.js 2>/dev/null") | crontab -
```

> Claude Code 的 crontab 方案不经过 Claude Agent，推送内容是脚本生成的固定格式，没有 AI 个性化。如需个性化推送，需要在脚本中调用 Claude API（用户自己提供 Key）。

### Step 5：立即运行一次（Welcome Run）

安装完成后立即执行一次完整的信号检测，让用户马上感受到价值：

> 设置完成！让我立即拉取当前市场信号，给你看看第一份报告长什么样。

执行完整的信号检测流程，生成当前市场状态报告 + 本期操作建议，推送给用户。推送完成后询问用户反馈，并根据反馈调整推送语气偏好（更简洁 / 更详细）。

---

## 3. 信号检测（定时运行）

每天早 8 点执行一次完整检测，每 30 分钟执行一次轻量价格检测。

### 3.1 数据拉取

| 数据 | 来源 | 频率 | 脚本 |
|------|------|------|------|
| 周期评分 + 链上指标 | signals-feed.json（你维护） | 每天一次 | fetch-signals.js |
| BTC 现价 / 24h 跌幅 | Binance 公开 API（无需 Key） | 每 30 分钟 | fetch-signals.js |
| 恐慌贪婪指数 | alternative.me（无需 Key） | 每天一次 | fetch-signals.js |
| 200 周均线 | Binance K 线自算 | 每天一次 | fetch-signals.js |

**signals-feed.json 格式（GitHub Actions 每天更新）：**

```json
{
  "updated_at": "2026-05-04",
  "cycle_score": 27,
  "mvrv_z": { "value": 0.8, "percentile": 18 },
  "puell": { "value": 0.62, "percentile": 22 },
  "nupl": { "value": -0.05, "percentile": 15 },
  "lth_supply_change": { "weekly_pct": 0.6, "trend": "increasing" },
  "exchange_reserve": { "percentile": 48, "trend": "neutral" },
  "funding_rate": { "value": -0.01, "signal": "negative" },
  "halving_months_since": 24,
  "etf_flow": { "signal": "inflow", "strength": "moderate" },
  "fgi": { "value": 9, "percentile": 5 },
  "degraded": false,
  "degraded_reason": null
}
```

### 3.2 触发判断逻辑

`check-triggers.js` 对照用户的策略配置（`~/.btc-dca/strategy.json`）判断当前是否触发：

#### 时间触发

- 每月 1 日和 15 日（或用户设定的日期）
- 判断今天是否是触发日期，是则生成时间触发提醒
- 金额 = 总预算 × 基础池比例 ÷ 总期数

#### 普通信号触发（满足任意 2 项，冷却期外）

| 条件 | 数据字段 | 阈值（示例：精算的守护者） |
|------|---------|------------------------|
| 单周价格跌幅 | Binance 7d change | > 15% |
| MVRV-Z 历史分位 | mvrv_z.percentile | < 25% |
| 恐慌贪婪指数 | fgi.value | < 20，且连续 5 天 |
| 长期持有者供应增加 | lth_supply_change.trend | = increasing，连续 2 周 |

触发后投入信号池的 15%，冷却期 14 天（由画像类型决定）。

#### 加速信号触发（满足任意 2 项）

| 条件 | 数据字段 | 阈值 |
|------|---------|------|
| MVRV-Z 历史分位 | mvrv_z.percentile | < 15% |
| 恐慌贪婪指数 | fgi.value | < 15，连续 10 天 |
| 单月价格跌幅 | Binance 30d change | > 30% |
| 长期持有者快速增加 | lth_supply_change.weekly_pct | > 1% |

触发后投入信号池的 25%，冷却期延长至 14 天。

#### 极端底部触发（必须同时满足以下条件）

| 条件 | 数据字段 | 阈值 |
|------|---------|------|
| MVRV-Z 值 | mvrv_z.value | < 1.2 |
| 恐慌贪婪指数 | fgi.value | < 10，连续 7 天 |
| 长期持有者月增 | lth_supply_change.monthly_pct（估算） | > 3% |

- 触发后极端池分 2 批释放，各 50%，间隔 7 天
- 极端触发只能使用一次，触发后标记 `extreme_used: true`

#### 浮亏预警触发

- 每天检查当前平均成本 vs 当前价格
- 账面亏损超过 30%：推送一次浮亏提醒（只推一次，不重复）
- 账面亏损超过 50%：推送自我宣言 + 详细操作建议
- 账面亏损超过 70%：推送极端情况应对指南

#### 跳过检测触发

- 用户回复跳过，或触发条件到期 7 天内未确认执行，记为一次跳过
- 连续跳过 3 次：主动推送重新评估建议
- 跳过记录存入 `~/.btc-dca/execution-log.json` 的 `skips` 字段

### 3.3 冷却期管理

| 画像类型 | 普通信号冷却期 | 加速信号冷却期 |
|---------|-------------|-------------|
| 冷静的猎人 / 沉默的鲸鱼 | 7 天 | 7 天 |
| 坚定的建设者 / 精算的守护者 | 14 天 | 14 天 |
| 情绪类型（信徒 / 参与者等） | 21 天 | 21 天 |
| 孤注的信仰者 | 14 天（强制） | 14 天（强制） |

---

## 4. 推送内容设计

所有推送内容由 Agent 根据当前数据和用户画像动态生成。如果用户配置了 Claude API Key，使用 Claude 生成个性化文案；否则使用模板。

### 4.1 时间触发提醒

```
【BTC 定投提醒】

今天是你的定投日（每月第 1 次）。

当前市场：周期评分 27 分，处于熊市积累区
本期建议买入：77,000 元（基础池，总预算 35% 的月度分配）

操作步骤：
1. 打开你的交易所
2. 买入约 77,000 元的 BTC
3. 回来告诉我成交价格，我来记录

买完回复：已买入 @价格（例如：已买入 @66200）
```

### 4.2 信号触发提醒

```
【信号触发 · 建议加速建仓】

检测到 2 项信号同时满足：
  ✓ MVRV-Z 历史分位 18%（低于阈值 25%）
  ✓ 恐慌贪婪指数 9，已连续 7 天极度恐慌

当前周期评分：27 分（熊市积累区）
当前价格：$66,200

建议本次加速买入：46,000 元（信号池 15%）

注：距离上次信号触发已 18 天，冷却期已结束。
操作完成后回复：已买入 @价格
```

### 4.3 浮亏提醒

```
【持仓情况提醒】

当前账面浮亏较大，给你发个提醒：

当前价格：$52,000
你的平均成本：$64,800
账面浮亏：约 -19.7%（约 -39,400 元）

这在策略预期范围内。你当初写道：

「策略选择的是信号触发而不是预测，跌幅越大，信号越强，我反而应该更冷静。」

当前信号状态：未触发加速条件，按正常节奏继续执行。
下次定投日：5 月 15 日
```

### 4.4 极端浮亏 + 自我宣言

```
【重要提醒 · 账面深度亏损】

当前账面浮亏已超过 50%。

现在展示你在制定策略时写下的话：

---
[用户的自我宣言全文]
---

当前信号状态：
  MVRV-Z：0.65（极度低估，历史第 8% 分位）
  恐慌贪婪：7（历史极值附近）

这些信号在历史上从未在非底部区出现过。

按规则执行，不要临场判断。你已经买了 3 次，
平均成本 $64,800，剩余子弹 83 万元。
```

### 4.5 连续跳过提醒

```
【策略执行提醒】

你已经连续跳过了 3 次触发信号：
  第 1 次：4 月 1 日（时间触发，已跳过 34 天）
  第 2 次：4 月 15 日（时间触发，已跳过 20 天）
  第 3 次：4 月 22 日（信号触发，已跳过 13 天）

连续跳过可能意味着策略和你的实际情况不匹配了。

建议重新评估一下策略。你可以：
  回复【评估策略】：我来引导你重新回答几道关键问题
  回复【继续执行】：保持当前策略不变，我继续提醒
  回复【暂停】：暂时停止提醒（30 天后我会再问你）
```

---

## 5. 执行记录与查询

### 5.1 记录方式

#### 方式一：文字输入（推荐）

用户说：`已买入 @66200`

Agent 回复：

```
好的，帮你记录这笔：

日期：2026-05-01
触发类型：时间触发（基础池）
买入金额：77,000 元
成交价格：$66,200
买入数量：约 0.01715 BTC

记录确认后写入本地？
```

用户确认后调用 `log-trade.js` 写入 `~/.btc-dca/execution-log.json`。

#### 方式二：截图识别

用户发送交易所成交截图，Agent 使用 Claude vision 识别，提取信息后展示：

```
我从截图里读到了这些信息，请确认：
  成交时间：2026-05-01 14:23
  买入金额：77,000 元
  成交价格：$66,200
  买入数量：0.0175 BTC
  手续费：约 77 元

信息正确吗？我确认后记录。
```

> ⚠️ 截图识别必须经过用户确认后才能写入，不允许自动写入。截图格式因交易所不同而差异较大，识别错误比没有记录更糟糕。

### 5.2 执行日志格式

```json
{
  "summary": {
    "total_invested": 1540000,
    "total_btc": 23.857,
    "avg_cost_usd": 64500,
    "remaining_budget": 460000,
    "pools": {
      "base_remaining": 210000,
      "signal_remaining": 180000,
      "extreme_remaining": 70000,
      "extreme_used": false
    },
    "last_trigger_date": "2026-04-22",
    "skip_count": 1,
    "drawdown_alerts_sent": [30]
  },
  "trades": [
    {
      "id": "trade_001",
      "date": "2026-05-01",
      "amount_cny": 77000,
      "price_usd": 66200,
      "btc_amount": 0.01715,
      "trigger_type": "time_base",
      "pool": "base",
      "note": ""
    }
  ],
  "skips": [
    {
      "date": "2026-04-22",
      "trigger_type": "signal_normal",
      "reason": "user_skip"
    }
  ]
}
```

### 5.3 状态查询

用户可以随时主动查询，Agent 调用 `analyze.js` 计算后返回：

```
用户：我现在定投情况怎么样？

Agent 回复：

【当前定投状态】

已执行：20 次  |  已投入：154 万元  |  用时：8 个月

持仓情况：
  持有 BTC：23.857 枚
  平均成本：$64,500（约 ¥468,800）
  当前价格：$66,200（约 ¥481,000）
  账面盈亏：+2.6%（约 +¥24,800）

子弹状态：
  基础池剩余：21 万元（已用 79%）
  信号池剩余：18 万元（已用 40%）
  极端池剩余：7 万元（未动用）
  总剩余：46 万元

下次触发：
  时间触发：5 月 15 日（13 天后），约 7.7 万元
  信号触发：当前未满足条件
    距离最近阈值：MVRV-Z 需再降 3 个百分位

按当前节奏，预计再需 6 个月完成建仓。
```

---

## 6. 策略管理

### 6.1 策略查询

```
用户：查看我的当前策略

Agent：

你的策略配置（精算的守护者）：

定投频率：双周投（每月 1 日和 15 日）
总预算：200 万元
子弹分配：基础池 35% / 信号池 30% / 极端池 35%
信号冷却期：14 天

普通信号触发条件（任意 2 项）：
  价格周跌幅 > 15%
  MVRV-Z 历史分位 < 25%
  恐慌贪婪 < 20，连续 5 天
  长期持有者供应增加

入场门槛：周期评分 ≤ 65 分
结束门槛：周期评分 > 35 分（暂停），> 65 分（停止）
```

### 6.2 轻调整（直接改参数）

用户说明想改什么，Agent 直接修改对应字段：

| 用户说 | Agent 操作 |
|--------|-----------|
| 我想改成月投 | 修改 frequency 为 monthly，更新 cron 计划 |
| 我想把基础池改成 40% | 修改 pools.base_pct，同步调整其他池比例 |
| 冷却期改成 7 天 | 修改 signal_trigger.cooldown_days |
| 我的预算增加了 50 万 | 修改 local.json 里的 precise_budget |

轻调整不需要重新做问卷，Agent 确认修改内容后直接更新 strategy.json。

### 6.3 深调整（重新评估画像）

当用户的根本情况发生变化时，触发深度评估。

**被动触发条件：**
- 连续跳过 3 次信号触发（Agent 主动建议）
- 账面浮亏超过 50% 持续 30 天（Agent 主动建议）

**主动触发：**
- 用户说【我想调整策略】或【重新评估】

**深调整流程：**

```
你的情况有变化，我来引导你重新回答几道关键问题（约 3 分钟）：

1. 这笔钱对你的重要程度有变化吗？
   A. 变成更重要了（需要更保守）
   B. 变成更闲了（可以更激进）
   C. 没有变化

2. 你的资金还会持续补充吗？
   A. 会，每月都有
   B. 不确定了
   C. 不会了，就这些
```

只重新回答变化最大的 3-5 道关键题目，不需要重做全部 15 道问卷。根据新答案计算新的五维度评分，如果画像类型改变则生成新的策略参数，覆盖旧的 strategy.json。

---

## 7. 对话指令参考

用户可以通过自然语言触发以下功能，Agent 应能识别语义相近的表达：

| 用户意图 | 示例说法 | Agent 动作 |
|---------|---------|-----------|
| 查状态 | 我现在怎么样 / 定投进展 / 剩多少子弹 | 调用 analyze.js，展示完整状态报告 |
| 记录执行 | 买了 / 已买入 @66200 / 刚买完 | 提取信息，确认后写入执行日志 |
| 发截图 | （直接发截图） | Vision 识别，提取信息，确认后写入 |
| 查策略 | 我的策略是什么 / 查看配置 | 读取 strategy.json，格式化展示 |
| 改策略 | 我想调整 / 改一下参数 | 询问改哪里，轻调整或触发深调整 |
| 跳过本次 | 这次先不买 / 跳过 / skip | 记录跳过，更新 skip_count |
| 手动触发分析 | 今日日报 / 信号怎么样 | 拉最新数据，实时分析并回答 |
| 暂停提醒 | 暂停 / 先别提醒我了 | 更新 config，设置 paused_until 字段 |
| 恢复提醒 | 恢复提醒 / 继续 | 清除 paused_until，恢复正常检测 |
| 查历史 | 我历史上买了几次 / 查看记录 | 读取 execution-log.json，展示交易历史 |

---

## 8. 本地数据文件完整格式

### 8.1 `~/.btc-dca/config.json`

```json
{
  "platform": "openclaw",
  "onboardingComplete": true,
  "timezone": "Asia/Shanghai",
  "checkTime": "08:00",
  "delivery": {
    "method": "openclaw",
    "channel": "telegram",
    "target": "123456789"
  },
  "notifications": {
    "verbosity": "normal",
    "paused_until": null
  },
  "signals_feed_url": "https://btc-dca.github.io/signals-feed.json",
  "claude_api_key": null
}
```

### 8.2 `~/.btc-dca/local.json`

```json
{
  "precise_budget": 2000000,
  "self_declaration": "你选择这个策略，是因为你真正理解 BTC 的价值逻辑...",
  "start_date": "2026-05-01"
}
```

### 8.3 `~/.btc-dca/strategy.json`（从服务端拉取，本地缓存）

```json
{
  "version": "1.0",
  "persona": {
    "type": "precise_guardian",
    "type_cn": "精算的守护者",
    "entry_threshold": 65,
    "exit_threshold_slow": 35,
    "exit_threshold_stop": 65
  },
  "frequency": "biweekly",
  "trigger_days": [1, 15],
  "pools": {
    "base_pct": 0.35,
    "signal_pct": 0.30,
    "extreme_pct": 0.35
  },
  "signal_trigger": {
    "cooldown_days": 14,
    "normal": {
      "conditions_required": 2,
      "price_drop_weekly": 0.15,
      "mvrv_percentile": 25,
      "fgi_value": 20,
      "fgi_days": 5,
      "lth_increasing": true
    },
    "accelerated": {
      "conditions_required": 2,
      "mvrv_percentile": 15,
      "fgi_value": 15,
      "fgi_days": 10,
      "price_drop_monthly": 0.30,
      "lth_weekly_pct": 0.01
    }
  },
  "extreme_trigger": {
    "mvrv_z_max": 1.2,
    "fgi_max": 10,
    "fgi_days": 7,
    "two_batches": true,
    "batch_interval_days": 7
  },
  "max_single_pct": 0.15,
  "drawdown_alerts": [30, 50, 70]
}
```

---

## 9. signals-feed.json 自动更新

这是你唯一需要维护的服务端逻辑，完全自动化，每天免费运行。

### 9.1 GitHub Actions 配置

```yaml
name: Update Signals Feed
on:
  schedule:
    - cron: '0 0 * * *'  # 每天 UTC 00:00（北京时间 08:00）
  workflow_dispatch:      # 允许手动触发
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install
      - run: node scripts/generate-feed.js
        env:
          GLASSNODE_KEY: ${{ secrets.GLASSNODE_KEY }}
      - name: Commit and push
        run: |
          git config --global user.email 'bot@btc-dca.app'
          git config --global user.name 'Feed Bot'
          git add signals-feed.json
          git diff --staged --quiet || git commit -m 'Update signals feed'
          git push
```

### 9.2 generate-feed.js 逻辑

- 拉取 Glassnode 免费层数据（MVRV-Z、Puell、NUPL、LTH 供应量）
- 拉取 alternative.me 恐慌贪婪指数
- 拉取 Binance K 线计算 200 周均线、当前价格
- 计算 ETF 流向（可选，SoSoValue 公开数据）
- 根据八指标权重计算周期位置综合评分
- 如果 Glassnode 不可用，设置 `degraded: true` 并记录原因
- 写入 signals-feed.json，提交到 GitHub

### 9.3 降级处理

| 情况 | 处理方式 | 对用户的影响 |
|------|---------|------------|
| Glassnode 正常 | 正常计算 8 指标综合评分 | 无影响 |
| Glassnode 免费层限制 | 只用 FGI + 资金费率 + 均线 3 项 | 评分置信度降低，标注说明 |
| GitHub Actions 失败 | 保留上一次的 feed，标注 stale | 用户收到数据延迟提醒 |
| Glassnode 收紧政策 | 切换 CryptoQuant 免费层 | 需要更新 generate-feed.js |

---

## 10. Claude Code 实现要求

### 10.1 SKILL.md 格式要求

参考 follow-builders/SKILL.md 的格式，但为降低每日 cron 任务的 token 消耗，Onboarding 拆
分为独立文件，采用渐进式加载（progressive disclosure）：

- `SKILL.md`（主文件，日常检测和交互都会加载，需保持精简）：
  - frontmatter：name、description、metadata（openclaw 配置）
  - 平台检测逻辑（OpenClaw vs 其他）
  - 首次安装判断（仅一段路由：未完成时读取 `onboarding.md` 并执行，完成则跳过）
  - 信号检测工作流（定时运行）
  - 用户交互处理（记录、查询、调整策略）
  - 配置管理（查看、修改各项设置）
- `onboarding.md`（独立文件，仅首次安装 / 用户主动要求重新引导时读取）：
  - 完整 Step 0 到 Step 5 流程（平台检测、策略配置、本地信息、推送渠道、定时任务、Welcome Run）

**原则：** `SKILL.md` 只放每次触发都可能用到的内容；只在特定场景（如首次安装）才需要的
长流程一律拆到独立文件，由 `SKILL.md` 按条件显式指向，避免日常 cron / 查询场景被迫加载
用不到的内容。

### 10.2 脚本技术要求

- Node.js 18+，使用 node-fetch 做 HTTP 请求
- 所有脚本必须有完整的错误处理，失败时输出可读的错误信息
- 数据文件读写使用 fs/promises，异步操作
- 不依赖任何数据库，只用本地 JSON 文件
- Telegram 推送使用官方 Bot API，不需要第三方库
- 截图识别调用 Claude API vision，需要用户提供 Claude API Key

### 10.3 安全要求

- 用户的精确预算和自我宣言只存本地，永不上传
- Telegram Token 只存 `~/.btc-dca/.env`，不写入任何其他文件
- Claude API Key 只存 `~/.btc-dca/config.json`，使用时从环境变量读取
- 所有网络请求只访问白名单域名：`api.binance.com`、`alternative.me`、`api.anthropic.com`、`api.telegram.org`
- Skill 只有建议和记录能力，不连接任何交易所 API，不做任何自动买卖

### 10.4 测试要求

- 安装完成后的 Welcome Run 必须正常推送
- 时间触发逻辑在测试时可以用 `--force` 参数跳过日期判断
- 截图识别测试覆盖币安、OKX 两个主流交易所格式
- 执行日志的读写测试覆盖首次写入、追加、并发写入三种情况
- 策略重新评估测试覆盖轻调整和深调整两种路径

---

*配合主产品文档 BTC智能定投产品文档.docx 一起使用*
