# 每日状态摘要模板

## 无触发（只推送日报）

```
【BTC 定投 · 每日早报】{{date}}

周期评分：{{cycle_score}} 分 · {{score_zone}}
恐慌贪婪：{{fgi_value}}（{{fgi_label}}）
当前价格：{{current_price}}

今日信号：未触发
{{cooldown_line}}
子弹剩余：基础池 {{base_remaining}} / 信号池 {{signal_remaining}} / 极端池 {{extreme_remaining}}
```

> `cooldown_line` 示例：
> - `距上次信号触发 3 天，冷静期剩余 4 天`
> - `今日未达触发门槛（当前 {{cycle_score}} 分，门槛 ≤ 28 分）`
> - `（暂无历史触发记录）`

---

## 有触发（日报 + 触发提醒合并输出）

```
【BTC 定投 · 每日早报】{{date}}

周期评分：{{cycle_score}} 分 · {{score_zone}}
恐慌贪婪：{{fgi_value}}（{{fgi_label}}）
当前价格：{{current_price}}

────────────────
⚡ 触发定投信号
────────────────

（此处接 alert-triggered.md 对应模板，从「信号说明」行开始）
```

---

## 数据过期警告（> 48h 未更新）

```
【BTC 定投 · 每日早报】{{date}}

⚠️ 链上数据已超过 48 小时未更新，信号判断暂停。

最后更新：{{last_updated}}
当前价格：{{current_price}}（来自 Binance 实时）

建议：稍后重试，或手动查询「现在适合买吗」。
```
