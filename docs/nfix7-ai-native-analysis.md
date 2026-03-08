# NFIX7 借鉴方案 — AI Native 深度分析

> 分析 NostalgiaForInfinityX7 (76k 行) 的核心技术，结合 TradeClaw 的 AI-native 架构，
> 评估每项技术的 AI 化潜力和实现优先级。

## TradeClaw 架构关键边界

```
AI 决策层 (软决策，可推理)          代码执行层 (硬规则，不可绕过)
─────────────────────────────      ──────────────────────────────
• Scanner 信号评估 GO/NO-GO        • Guard 管道 (仓位/余额/冷却)
• thinkBeforeTrade 置信度评估       • EmotionGuard 自动缩仓
• 情绪状态跟踪 (Brain)              • TradeManager SL/TP 自动执行
• 收紧 SL / 调整 TP                 • 最大仓位 40% 权益硬限
• 交易复盘 + 模式学习               • 最小余额 30% 硬限
```

核心原则：**AI 做判断，代码做执行**。NFIX7 用 6800 行布尔条件做的事，TradeClaw 让 AI 推理。

---

## 一、NFIX7 Entry 信号分析

### NFIX7 现状
- 27 个独立入场信号 (signal_1 ~ signal_163)，OR 聚合
- 每个信号 = 多时间帧指标 AND 链 (RSI_3, AROONU, STOCHRSIk, CCI, CMF, ROC)
- 按模式分类：Normal(1-6), Quick(21), Medium(41-46), Rapid(101-104), Grind(120), Aggressive(141-145), Trend(161-163)
- 6800 行 `protections_long_global` 作为入场前置过滤

### TradeClaw 现状
- Scanner 多因子评分 (trend/momentum/acceleration/structure/candle/volume/volatility/funding)
- 4H 评分 → 1H entry trigger → 精确 SL/TP
- AI 独立判断 raw 指标值，可以否决/升级 Scanner 结论

### AI Native 改造方向

| NFIX7 技术 | NFIX7 实现 | AI Native 版本 | 契合度 |
|-----------|-----------|---------------|--------|
| 27 个入场信号 | 硬编码布尔链 | **已有** — Scanner pipeline 覆盖 | ★★★★★ |
| 多时间帧过滤 | 6800 行 AND 条件 | **喂数据给 AI** — 把 5m/15m/1h/4h RSI_3 作为 raw 指标暴露 | ★★★★★ |
| Rapid 模式 (大跌 50% 入场) | `close > close_max_12 * 0.5` | **AI 推理** — "1h 内跌幅超 50%，是否是抄底机会？" | ★★★★☆ |
| Grind 模式 (盈利加仓) | 固定 1.8% 阈值 | **已有 DCA** — reversal profile 的加仓逻辑 | ★★★★☆ |
| 入场标签系统 | enter_tag 数字编号 | **已有** — triggerType + profile 映射 | ★★★★★ |

**结论**：Entry 方面 TradeClaw 的 Scanner + AI 推理已经覆盖了 NFIX7 的核心逻辑。
唯一差距是 **多时间帧快速动量数据** (RSI_3 across 5m/15m/1h/4h) 暴露给 AI。

---

## 二、NFIX7 Exit 信号分析

### NFIX7 现状
- 10 种退出模式，按 entry_tag 路由到不同 exit handler
- 每种模式的退出优先链：signals → main → williams_r → dec → stoploss → profit_target
- 关键创新：
  1. **利润分级 RSI 退出** — 小利润时 RSI<10 才退，大利润时 RSI<42 就退
  2. **延迟止损** — SL 信号触发后缓存，等 60 分钟看是否恢复
  3. **3 级止损** — doom(灾难) / u_e(技术) / 常规
  4. **Rapid 微利退出** — 0.5%~9% 利润时 10 个额外退出条件

### AI Native 改造评估

#### ★★★★★ 利润分级退出灵感度 (Profit-Tier Dynamic Exits)

**NFIX7**: 固定 RSI 阈值表 (0.1%→RSI<10, 1%→RSI<28, 5%→RSI<36, 20%→RSI<42)

**AI Native 版本**:
```
不需要写死阈值表。每个 heartbeat 给 AI 以下数据：
- 当前利润 %
- RSI_14 (5m/1h)
- 价格相对 EMA_200 位置
- 交易持续时间
- profile 类型

AI 推理："这笔 trend 交易赚了 8%，1H RSI 已经 72，但 4H 趋势还在，
我选择收紧 trailing 而不是立刻退出。"

vs 纯规则版："8% 利润 + RSI>38 = 退出"
```

**实现**：在 heartbeat 注入更丰富的实时指标数据，让 AI 做退出判断。
代码层面只保留硬止损作为安全网。

#### ★★★★★ 延迟止损 (Deferred Stoploss)

**NFIX7**: 缓存 SL 信号 → 等 60 分钟 → 利润未恢复才执行

**AI Native 版本**:
```
当 SL 即将触发时（价格接近 SL 但未穿越），AI 获得通知：
"BTC/USDT 距 SL 仅 0.3%，1H RSI=22 (深度超卖)，
过去 4 根 K 线有长下影线。要提前触发还是给时间恢复？"

AI 可以选择：
1. 不操作（让自动 SL 执行）
2. 收紧 SL（减少损失）
3. 暂时放宽 SL 0.5x ATR（给恢复空间，有 DCA 兜底）
```

**实现**：在 SL 接近触发时（<0.5% 距离）生成 agent-event 通知 AI。
这比 NFIX7 的固定 60 分钟等待更智能。

#### ★★★★☆ 模式路由退出 (Mode-Routed Exits)

**NFIX7**: entry_tag → 不同退出处理器（rapid 更激进，grind 更保守）

**AI Native 版本**:
```
已有！profile (trend/reversal/breakout/scalp) 驱动：
- 不同 progressive protection 阶梯
- 不同 trailing 配置
- 不同 TP 比例

可增强：在 heartbeat summary 中显示 profile，
让 AI 知道 "这是 scalp 交易，应该快进快出"
```

#### ★★★☆☆ Rapid 微利退出

**NFIX7**: 10 个额外条件在 0.5%~9% 利润窗口

**AI Native 版本**: scalp profile 的 progressive stages 已经在 +0.5x ATR 就开始保护。
可以加强：暴露 Williams %R 和 MFI 给 AI，让它在微利时更敏感。

---

## 三、风控技术 AI Native 评估

### ★★★★★ 多级 Partial De-risk (渐进减仓)

**NFIX7**: -6%/-8%/-10% 分别卖出 10% 仓位

**AI Native 版本**:
```
当前：价格触及 SL → 全部止损
改进：在 SL 之前增加 "预警区域"

AI 看到："ETH 亏损 -4%，接近 reversal profile 的 stage 1 阈值。
当前有 2 层 DCA 已填，但 4H 趋势仍向下。
建议：先减仓 30% 降低风险，保留 70% 等 DCA 止盈。"

代码层面：新增 `PartialExitGuard`
- 当亏损达到 N×ATR 时建议减仓（不自动执行，推给 AI 判断）
- AI 决定减多少（10%/20%/30%）
- 保底：SL 依然是自动硬止损
```

**契合度极高** — 这恰好是 AI 擅长的：**根据上下文决定减仓比例**，
而不是像 NFIX7 一样固定 10%。

### ★★★★★ 多时间帧崩盘防护 (Crash Guard)

**NFIX7**: 6800 行布尔条件检查 5 个时间帧的 RSI/CCI/CMF

**AI Native 版本**:
```
不需要 6800 行代码。在 Scanner heartbeat 中增加：

crashIndicators: {
  rsi3_5m: 8,     // 极度超卖
  rsi3_15m: 12,
  rsi3_1h: 25,
  rsi3_4h: 45,    // 高时间帧还没跌
  cci_1h: -180,
  cmf_1h: -0.25,
}

AI 推理："5m/15m RSI_3 崩了但 4H 还高 → 正在瀑布下跌，
4H 还没 oversold 说明下跌空间还大。阻止开仓。"

这比 6800 行 AND 条件更灵活，因为 AI 能判断：
- "虽然 5m 崩了但 1H 出现吞没 K 线，可能是假摔" → 允许开仓
- "所有时间帧同时 RSI<20，这是投降式抛售" → 开仓（逆向）
```

**实现**：
1. Scanner 增加 RSI_3 多时间帧采样 (新增 ~30 行代码)
2. heartbeat 注入 crash indicators
3. AI 自行判断是否阻止开仓

### ★★★★☆ 入场滑点保护 (Slippage Guard)

**NFIX7**: `rate / last_close - 1 > 1%` → 取消

**AI Native 版本**: 纯规则就够了，不需要 AI。加到 Guard pipeline 即可。

```typescript
// SlippageGuard — 新增到 guards/
if (Math.abs(executionPrice - signalPrice) / signalPrice > 0.01) {
  return { allowed: false, reason: 'slippage > 1%' }
}
```

### ★★★★☆ 资金费率感知 (Funding Fee Integration)

**NFIX7**: `total_profit += trade.funding_fees`

**AI Native 版本**:
```
当前 heartbeat 已有 funding rate 数据。改进：
1. 累积 funding 成本计入 P&L 显示
2. AI 看到 "这笔 long 已经付了 $12 funding，占浮盈的 40%"
3. AI 决定："funding 成本太高，应该提前平仓"

代码层面：TradeManager P&L 计算加入累积 funding
```

### ★★★☆☆ 清算价感知 (Liquidation Awareness)

**NFIX7**: `confirm_trade_exit` 检查清算价

**AI Native 版本**: 计算清算价，在 heartbeat 中展示。AI 自行判断距离是否安全。

### ★★★☆☆ DCA 时间冷却 (Cooldown Timer)

**NFIX7**: 加仓间隔 5 分钟 + 6 小时冷却

**AI Native 版本**: 简单规则即可。在 DCA layer 中加 `minIntervalMs: 5 * 60 * 1000`。

### ★★☆☆☆ Hold 名单覆盖

**NFIX7**: 外部 JSON 文件指定不卖

**AI Native 版本**: AI 已经能通过 `cryptoUpdateTradePlan` 收紧/放松。
如果真要 hold，AI 直接把 TP 移远即可。不需要额外功能。

### ★★☆☆☆ 币种分级白名单

**NFIX7**: grind_mode_coins 列表

**AI Native 版本**: AI 已经能看到 Scanner 评分。
低评分币自然不会被选中。可以加到 system prompt 作为偏好。

---

## 四、综合优先级排序

### Tier 1: 高价值 + 高 AI 契合度 (建议实现)

| # | 功能 | 核心改动 | AI 角色 | 代码角色 |
|---|------|---------|---------|---------|
| 1 | **多时间帧 RSI_3 崩盘数据** | Scanner 增加 RSI_3 采样 | 判断是否崩盘/投降 | 提供数据 |
| 2 | **Partial De-risk (渐进减仓)** | 新 tool `cryptoPartialExit` | 决定减多少 | 执行减仓 |
| 3 | **SL 接近预警 → AI 介入** | agent-event 在 SL<0.5% 时触发 | 决定收紧/放松/不动 | 触发预警 |
| 4 | **利润动态退出数据** | heartbeat 增加 RSI + EMA 位置 | 决定是否提前获利了结 | 提供数据 |

### Tier 2: 中等价值 (可选实现)

| # | 功能 | 核心改动 | 说明 |
|---|------|---------|------|
| 5 | **入场滑点 Guard** | 新 Guard ~20 行 | 纯规则，不需 AI |
| 6 | **资金费率累积 P&L** | TradeManager P&L 计算 | 数据增强给 AI |
| 7 | **DCA 冷却时间** | DCA checkTrigger 加时间检查 | 纯规则 |
| 8 | **清算价计算 + 展示** | heartbeat 增加清算价 | 数据增强给 AI |

### Tier 3: 低优先级 (暂不需要)

| # | 功能 | 原因 |
|---|------|------|
| 9 | Hold 名单 | AI 已可调 TP/SL |
| 10 | 币种白名单 | Scanner 评分已覆盖 |
| 11 | 延迟止损 60 分钟固定等待 | SL 预警 + AI 介入 更灵活 |
| 12 | RSI 退出阈值表 | AI 推理比固定表更好 |

---

## 五、Tier 1 实现方案草案

### 1. 多时间帧 RSI_3 崩盘数据

**改动文件**: `entry-trigger.ts` 或新增 `crash-indicators.ts`

```typescript
interface CrashIndicators {
  rsi3: Record<'5m' | '15m' | '1h' | '4h', number>
  cci20_1h: number
  cmf20_1h: number
  isCrashing: boolean  // 简单判断：3+ 时间帧 RSI_3 < 20
  crashSeverity: 'none' | 'mild' | 'severe' | 'capitulation'
}
```

**数据来源**: OHLCV 已在 Scanner 中获取，只需增加 RSI_3 计算（~10 行）

**AI 使用方式**: heartbeat 注入 `crashIndicators`，AI 在 thinkBeforeTrade 中引用

### 2. Partial De-risk (渐进减仓)

**新增 tool**: `cryptoPartialExit`

```typescript
cryptoPartialExit: tool({
  description: '对活跃仓位执行部分平仓，减少风险敞口。',
  inputSchema: z.object({
    planId: z.string(),
    exitRatio: z.number().min(0.1).max(0.5),  // 最多减 50%
    reason: z.string(),
  }),
  execute: async ({ planId, exitRatio, reason }) => {
    // 计算退出数量 = positionSize * exitRatio
    // 调用 engine.forceExit 部分平仓
    // 更新 plan.positionSize, 记录 realizedPnl
  },
})
```

**AI 使用场景**:
- 亏损接近 SL 但 AI 判断可能恢复 → 先减 20%
- 利润很高但动量减弱 → 先锁定 30% 利润
- DCA 加仓后市场继续跌 → 减仓控制总风险

### 3. SL 接近预警

**改动文件**: `TradeManager.ts` 的 `processPlan`

```typescript
// 在 checkSlBreach 之前
const slDistance = isLong
  ? (currentPrice - plan.stopLoss.price) / plan.stopLoss.price
  : (plan.stopLoss.price - currentPrice) / plan.stopLoss.price

if (slDistance > 0 && slDistance < 0.005 && !plan.slWarningEmitted) {
  plan.slWarningEmitted = true
  this.emitEvent(plan, 'sl_warning',
    `⚠️ ${plan.symbol} 距 SL 仅 ${(slDistance * 100).toFixed(2)}%！` +
    `当前价 $${currentPrice}, SL $${plan.stopLoss.price}。` +
    `RSI_14: ${latestRsi}. 需要干预吗？`)
}
```

### 4. 利润动态退出数据

**改动文件**: heartbeat summary 增加指标

```typescript
// TradeManager.getSummaryForHeartbeat 增加
if (pnl && pnl.unrealizedPnlPct > 1.0) {
  // 获利超过 1% 时提供退出参考指标
  pnlStr += ` | RSI_14: ${rsi14} | EMA200: ${aboveEma200 ? 'above' : 'below'}`
}
```

---

## 六、NFIX7 vs TradeClaw 哲学对比

| 维度 | NFIX7 (规则驱动) | TradeClaw (AI 驱动) |
|------|-----------------|-------------------|
| **入场** | 27 个信号 OR，6800 行过滤 | Scanner 评分 + AI 独立判断 |
| **退出** | 10 个模式 × 6 层优先链 | Profile 驱动 SL/TP + AI 动态调整 |
| **风控** | 固定阈值 (doom -10%, derisk -6%) | Guard 硬限 + AI 情绪感知缩仓 |
| **学习** | 无 | 交易复盘 + 模式记忆 + 情绪追踪 |
| **适应性** | 靠人工调参 | AI 推理适应市场状态 |
| **代码量** | 76,000 行 | ~5,000 行 + AI 推理 |

**核心洞察**: NFIX7 用 76k 行代码来"穷举"市场状态，
TradeClaw 用 AI 来"推理"市场状态。
我们要借鉴的不是它的规则，而是它的**数据维度**和**风控分层思想**。

---

## 七、不做的事情

1. **不抄 6800 行过滤条件** — AI 看数据自己判断
2. **不做 10 种退出模式** — 4 个 profile 已覆盖
3. **不做利润缓存文件** — AI 每次 heartbeat 重新评估
4. **不做 27 个入场信号** — Scanner pipeline 已是多因子
5. **不做无限 DCA/Grind** — 2 层 DCA + 硬止损已够安全
