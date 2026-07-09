# 首次安装（Onboarding）

> 本文件仅在首次安装 / 用户主动要求重新引导时读取和执行。日常的定时检测、状态查询、
> 策略调整等场景请直接参考 `SKILL.md`，不需要读取本文件。

检查条件：`~/.btc-dca/config.json` 不存在，或其中 `onboardingComplete` 不为 `true`。

## Step 0：平台检测

```bash
if which openclaw 2>/dev/null; then
  echo 'PLATFORM=openclaw'
elif which hermes 2>/dev/null; then
  echo 'PLATFORM=hermes'
else
  echo 'PLATFORM=other'
fi
```

将结果记录为 `platform` 字段，后续 Step 3 和 Step 4 据此分支。

---

## Step 1：读取策略配置

**首先**，按优先级检查触发本次对话的用户消息（包括安装引导消息）：

1. 消息中包含 `策略参数：{JSON}` 格式 → **直接进入路径 A-JSON**（推荐，无需执行脚本）
2. 消息中包含 `导入码：<CODE>` 格式 → 进入路径 A-脚本解码
3. 以上均无 → 进入路径 B（问卷式生成）

**无导入码时**，对用户说：

> 你好！我是你的 BTC 智能定投助手。
>
> 请问你有**导入码**吗？（在 https://zoe-zhouzhou.github.io/btc-dca/ 完成问卷后，策略页会生成一串导入码）
>
> - 有的话直接粘贴给我
> - 没有也没关系，我问你 5 个问题，2 分钟内帮你生成策略

---

### 路径 A-JSON：直接写入（优先）

安装消息中包含 `策略参数：{...}` 时，将该 JSON 直接写入 `~/.btc-dca/strategy.json`：

```bash
mkdir -p ~/.btc-dca
cat > ~/.btc-dca/strategy.json << 'ENDJSON'
<STRATEGY_JSON>
ENDJSON
echo OK
```

其中 `<STRATEGY_JSON>` 替换为消息中 `策略参数：` 后面的完整 JSON 字符串（heredoc 写法对 JSON 中的双引号完全安全）。

如果你的工具支持直接写入文件，也可以跳过上述脚本，直接将 JSON 写入 `~/.btc-dca/strategy.json`。

**成功条件：** 脚本输出 `OK`，且 `~/.btc-dca/strategy.json` 存在。

---

### 路径 A-脚本：有导入码 → 解码（备选）

仅在消息中有 `导入码：<CODE>` 但无 `策略参数：{JSON}` 时使用：

```bash
mkdir -p ~/.btc-dca
node -e "
var code = '<CODE>';
var b64 = code.replace(/-/g,'+').replace(/_/g,'/');
while (b64.length % 4) b64 += '=';
var parts = Buffer.from(b64,'base64').toString().split(',');
if (parts.length < 11) { console.error('INVALID'); process.exit(1); }
var strategyKeys = ['base_bullet_pct','signal_bullet_pct','extreme_bullet_pct',
  'dca_frequency','base_pool_entry_score',
  'normal_signal_cooldown_days','accel_signal_cooldown_days',
  'quasi_extreme_cooldown_days','extreme_signal_cooldown_days','max_single_position_pct'];
var strategy = {};
strategyKeys.forEach(function(k,i){
  var val = parts[i + 1];
  if (k === 'dca_frequency') { strategy[k] = val === 'w' ? 'weekly' : 'biweekly'; }
  else { strategy[k] = +val; }
});
strategy.signal_score_threshold = parts[11] ? +parts[11] : 28;
var obj = {
  persona: parts[0],
  strategy: strategy
};
require('fs').writeFileSync(require('os').homedir()+'/.btc-dca/strategy.json', JSON.stringify(obj,null,2));
console.log('OK');
"
```

**成功条件：** 脚本输出 `OK`，且 `~/.btc-dca/strategy.json` 存在。失败（`INVALID`）时提示格式有误，请返回网页端重新生成。

成功后展示摘要（路径 A-JSON 和 A-脚本均适用）：

> 已读取你的策略配置：
>
> 画像：[persona 中文名]
> 定投频率：[strategy.dca_frequency → 每周 / 每两周]
> 子弹分配：基础池 [strategy.base_bullet_pct]% / 信号池 [strategy.signal_bullet_pct]% / 极端池 [strategy.extreme_bullet_pct]%
> 基础定投触发：周期分 ≤ [strategy.base_pool_entry_score] 分
>
> 这是你的策略吗？

persona 中文名对照（供上方摘要使用）：
calm_hunter=冷静的猎人 / silent_whale=沉默的鲸鱼 / determined_builder=坚定的建设者 /
curious_explorer=好奇的探索者 / precise_guardian=精算的守护者 / cautious_observer=谨慎的观察者 /
faithful_believer=谨慎的信徒 / trend_follower=跟风的尝试者 / anxious_participant=焦虑的参与者 /
confused_entrant=迷茫的入场者 / allin_idealist=孤注的信仰者 / conservative_watcher=保守的观望者

---

### 路径 B：无导入码 → 对话式 5 题问卷

逐题询问（每次只问一题，等待回答后再出下一题）：

**Q1（资金性质）：** 这笔投入 BTC 的钱，性质是？
- A. 完全是不需要动的闲钱，准备放几年 → fn=5
- B. 主要是闲钱，但偶尔可能动用 → fn=4
- C. 是余钱，但有流动性要求 → fn=3
- D. 有生活资金压力，不是完全闲置 → fn=2

**Q2（心理韧性）：** 如果账面亏损超过 50%，你会？
- A. 正常，符合预期，继续定投 → r=5
- B. 难受，但能坚持 → r=4
- C. 焦虑，可能减仓 → r=3
- D. 很难接受，可能全清出 → r=2

**Q3（BTC 认知）：** 你对 BTC 的了解程度？
- A. 研究过链上数据、减半周期、历史熊市规律 → kn=5
- B. 了解基本逻辑，长期看多 → kn=4
- C. 觉得能涨，但没深入研究 → kn=3
- D. 跟风入场，说不清为什么 → kn=2

**Q4（资金结构）：** 这笔钱占你可投资资产的比例？
- A. 10% 以下 → fs=5
- B. 10%–30% → fs=4
- C. 30%–50% → fs=3
- D. 50% 以上 → fs=2

**Q5（退出周期）：** 你计划定投完成后持有多久？
- A. 3 年以上，穿越完整牛熊 → eh=5
- B. 1–3 年 → eh=4
- C. 6 个月–1 年 → eh=3
- D. 不确定，看情况 → eh=2

收到全部回答后，计算综合风险分并映射策略：

```
risk = (fn×2 + r×2 + fs + eh) / 7
```

| risk | persona | 基础/信号/极端池 | 定投频率 |
|------|---------|----------------|---------|
| ≥ 4.0 | calm_hunter | 15/30/55 | weekly |
| ≥ 3.5 | determined_builder | 20/30/50 | biweekly |
| ≥ 2.5 | faithful_believer | 25/30/45 | biweekly |
| ≥ 1.8 | cautious_observer | 35/30/35 | biweekly |
| < 1.8 | conservative_watcher | 45/25/30 | biweekly |

其余参数（冷静期、单次仓位上限）用标准值：

```json
{
  "base_pool_entry_score": 28,
  "normal_signal_cooldown_days": 7,
  "accel_signal_cooldown_days": 10,
  "quasi_extreme_cooldown_days": 7,
  "extreme_signal_cooldown_days": 7,
  "max_single_position_pct": 25
}
```

生成 strategy.json 并展示摘要，询问用户确认：

> 已根据你的回答生成策略配置：
>
> 画像：[persona 中文名]
> 定投频率：[每周 / 每两周]
> 子弹分配：基础池 [x]% / 信号池 [x]% / 极端池 [x]%
>
> 这符合你的预期吗？（确认后继续，或告诉我需要调整哪里）

用户确认后，写入 `~/.btc-dca/strategy.json`（格式与路径 A 一致）。

---

## Step 2：补充本地信息

提问一：

> 还需要两个只存在你本地的信息：
>
> **① 你的总预算是多少？**（例如：100万、500000、20000）
> 这个数字只存在你的电脑上，不会上传。

将用户回答解析为整数（支持"100万"→1000000 / "50w"→500000 / 纯数字）。

提问二（根据 persona 生成对应宣言，若无 Claude API 则用通用模板）：

> **② 这是你的自我宣言，当账面亏损超过 50% 时我会展示给你看：**
>
> 「你选择这个策略，是因为你真正理解 BTC 的价值逻辑。跌幅不是亏损，是机会。你的定投计划是在市场最恐慌的时候保持理性的承诺，而不是预测底部的赌注。」
>
> 直接确认，或告诉我哪里需要修改。

用户确认后，写入 `~/.btc-dca/local.json`：

```json
{
  "precise_budget": <整数>,
  "self_declaration": "<用户确认的宣言>",
  "start_date": "<今天 YYYY-MM-DD>"
}
```

---

## Step 3：配置推送渠道

**如果 platform = openclaw：**

> 你正在使用 OpenClaw，我可以直接推送到当前频道。
> 应该推送到这个频道吗？还是推送到其他地方（Telegram / Discord）？

获取渠道名称和 target ID 后，更新 `config.json` 的 `delivery` 字段。

**如果 platform = hermes：**

检查 Hermes Gateway 状态：

```bash
hermes gateway status
```

若 gateway 正常运行，询问推送目标：

> 你正在使用 Hermes Agent，可以推送到你已连接的任意渠道。
> 希望推送到哪里？（例如：`telegram` / `telegram:你的ChatID` / `discord:#频道名` / `all` 推到所有渠道）

若 gateway 未配置，引导运行：

```bash
hermes gateway setup
```

按提示完成渠道配置后继续。

获取目标后，更新 `config.json` 的 `delivery` 字段：`{ "method": "hermes", "target": "<用户选择的目标>" }`

---

**如果 platform = other（Claude Code 等）：**

> 你使用的不是 OpenClaw 或 Hermes Agent，需要一个推送渠道才能主动提醒你。
> 推荐 Telegram，免费，约 5 分钟搞定。你有 Telegram 吗？

引导创建 Telegram Bot：

1. 打开 Telegram，搜索 **@BotFather**
2. 发送 `/newbot`，按提示创建 Bot
3. 复制 BotFather 给你的 **Token**
4. 打开你的新 Bot，发一条任意消息（必须先发，否则无法收到推送）
5. 运行以下命令获取你的 **Chat ID**：

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['message']['chat']['id'])"
```

获取 Token 和 Chat ID 后，写入 `~/.btc-dca/.env`：

```
TELEGRAM_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat_id>
```

同时更新 `config.json` 的 `delivery.method` 为 `"telegram"`。

---

## Step 4：设置定时任务

**OpenClaw（v1 主力）：**

OpenClaw 的 cron 通过自然语言 `--message` 触发一个 isolated session，该 session 读取本文件并自行完成检测和推送，无需在 message 中写 shell 命令：

```bash
SKILL_DIR="$(pwd)"
openclaw cron add \
  --name "BTC 定投信号检测" \
  --cron "0 8 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "运行 BTC 定投 Skill：读取 $SKILL_DIR/SKILL.md，拉取市场信号，判断是否触发定投，如有触发则推送提醒给用户" \
  --announce \
  --channel <用户选择的渠道名称> \
  --to "<target ID>" \
  --exact
```

> ⚠️ **不要使用 `--channel last`**，必须指定明确的渠道名称和 target ID，避免多渠道配置下投递失败。

**Hermes Agent（v1 主力）：**

```bash
SKILL_DIR="$(pwd)"
hermes cron create "0 8 * * *" \
  "运行 BTC 定投 Skill：读取 $SKILL_DIR/SKILL.md，拉取市场信号，判断是否触发定投，如有触发则推送提醒给用户" \
  --skill btc-dca-skill \
  --deliver <用户配置的 target> \
  --name "BTC 定投信号检测"
```

验证：

```bash
hermes cron list
```

输出中应看到 `BTC 定投信号检测`，状态为 enabled。

---

**其他平台（Claude Code 等）：**

每日早 8 点的提醒靠 macOS 原生的 launchd 定时任务实现，写入用户目录无需额外权限：

```bash
SKILL_DIR="$(pwd)"
mkdir -p ~/.btc-dca
cat > ~/Library/LaunchAgents/com.btc-dca.daily-check.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.btc-dca.daily-check</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>i=0; while ! curl -sf --max-time 5 https://api.telegram.org &gt;/dev/null 2&gt;&amp;1; do i=$((i+1)); [ $i -ge 30 ] &amp;&amp; break; sleep 10; done; cd $SKILL_DIR &amp;&amp; node scripts/fetch-signals.js | node scripts/check-triggers.js | node scripts/deliver.js --verbose</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${HOME}/.btc-dca/cron.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.btc-dca/cron-error.log</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.btc-dca.daily-check.plist
launchctl list | grep btc-dca
```

成功后输出类似：

```
- 0 com.btc-dca.daily-check
```

`-` 表示当前未运行（正常），`0` 表示上次退出码为成功。日志路径：`~/.btc-dca/cron.log`（正常输出）/ `cron-error.log`（错误）。

> 如果不想设置定时任务，每天手动问「今天信号怎样」效果完全一样，只是不自动推送。

---

## Step 5：Welcome Run（立即运行一次）

> 设置完成！让我立即拉取当前市场信号，给你看看第一份报告。

**OpenClaw 模式**：直接在当前对话执行检测（见「定时检测工作流·OpenClaw 模式」），将结果展示给用户。

**Hermes Agent 模式**：直接在当前对话执行检测（见「定时检测工作流·Hermes Agent 模式」），将结果展示给用户。

**Claude Code 模式**：

```bash
node scripts/fetch-signals.js | node scripts/check-triggers.js | node scripts/deliver.js --verbose
```

展示报告后，标记安装完成，写入 `~/.btc-dca/config.json`（完整格式）：

```json
{
  "platform": "<openclaw|hermes|other>",
  "onboardingComplete": true,
  "timezone": "Asia/Shanghai",
  "checkTime": "08:00",
  "delivery": {
    "method": "<openclaw|hermes|telegram>",
    "channel": "<频道名称，仅 openclaw>",
    "target": "<渠道目标，openclaw 为 target ID，hermes 为 deliver 目标如 telegram/all>"
  },
  "notifications": {
    "verbosity": "normal",
    "paused_until": null
  },
  "signals_feed_url": "https://zoe-zhouzhou.github.io/btc-dca/signals-feed.json"
}
```

询问用户反馈，并根据反馈在 `notifications.verbosity` 填写 `"concise"` 或 `"verbose"`。
