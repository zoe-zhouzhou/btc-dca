# 触发提醒模板

## 时间触发（time_base）

```
【BTC 定投提醒 · 时间型】

今天是你的定投日（{{freq_label}}）。

当前市场：周期评分 {{cycle_score}} 分，{{score_zone}}
当前价格：{{current_price}}
建议买入：{{amount}}（基础池分批，剩余 {{base_remaining}}）

操作步骤：
1. 打开你的交易所
2. 买入约 {{amount}} 的 BTC
3. 买完回复：已买入 @成交价（例：已买入 @66200）
```

---

## 普通信号触发（signal_normal）

```
【信号触发 · 普通定投信号】

检测到普通买入信号：
  ✓ 综合周期评分 {{cycle_score}} 分（≤ 28）
  ✓ {{loose_count}}/8 项指标归一化 ≤ 40
  ✓ MVRV ratio {{mvrv_ratio_value}}（< 1.5）

当前价格：{{current_price}}
建议买入：{{amount}}（信号池 × 6%，剩余 {{signal_remaining}}）

注：距上次信号触发已 {{days_since_last}} 天，冷静期已结束。
买完回复：已买入 @成交价
```

---

## 加速信号触发（signal_accel）

```
【信号触发 · 加速定投信号】

多项深度低估指标共振：
  ✓ 周期评分 {{cycle_score}} 分（≤ 30）
  ✓ {{strict_count}}/8 项归一化分 ≤ 25（深度低估）
  ✓ MVRV ratio {{mvrv_ratio_value}}（< 1.2）
  ✓ 恐慌贪婪指数 {{fgi_value}}（< 15）

当前价格：{{current_price}}
建议买入：{{amount}}（信号池 × 10%，剩余 {{signal_remaining}}）

买完回复：已买入 @成交价
```

---

## 准极端信号触发（signal_quasi）

```
【信号触发 · 准极端信号 ⚡】

多重底部信号共振，建议重点建仓：
  ✓ 周期评分 {{cycle_score}} 分
  ✓ MVRV ratio {{mvrv_ratio_value}}（< 1.0）
  ✓ 恐慌贪婪指数 {{fgi_value}}（极度恐慌，< 12）

当前价格：{{current_price}}
建议买入：{{amount}}（极端池 × 12%，剩余 {{extreme_remaining}}）

⚠️ 冷静期 7 天，集中火力把握底部窗口。
买完回复：已买入 @成交价
```

---

## 极端底部信号触发（signal_extreme）

```
【信号触发 · 极端底部信号 🔥🔥🔥】

历史级别底部信号，全部极端条件满足：
  ✓ 周期评分 {{cycle_score}} 分（历史极端区）
  ✓ MVRV ratio {{mvrv_ratio_value}}（< 0.85）
  ✓ 恐慌贪婪指数 {{fgi_value}}/100（历史极值附近）
  ✓ Puell Multiple {{puell_value}}（矿工深度亏损期）

当前价格：{{current_price}}
建议买入：{{amount}}（极端池 × 20%，剩余 {{extreme_remaining}}）

这类信号在历史上每轮熊市仅出现 1–3 次。
买完回复：已买入 @成交价
```
