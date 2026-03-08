# DCA + Signal Profile 设计方案

## 核心思路

借鉴 NFIX7 的两个核心优势，融入 TradeClaw 的 AI + Scanner 架构：

1. **DCA (Dollar Cost Averaging)** — 高置信度信号跌了加仓摊低成本，而不是直接止损
2. **Signal Profile (信号画像)** — 不同类型的交易信号，使用不同的风控参数

两者结合：**信号类型决定是否启用 DCA、SL 宽度、TP 策略**。

---

## 一、Signal Profile — 信号画像

### 设计：TradeProfile 枚举

根据 Scanner 的 entry trigger 类型 + regime，映射为 4 种交易画像：

| Profile | 适用场景 | SL 策略 | TP 策略 | DCA |
|---------|----------|---------|---------|-----|
| `trend` | EMA趋势确认 + 趋势市 | 宽 SL (2.0x ATR)，Chandelier 追踪 | 后装 30/30/40，让利润跑 | 不 DCA |
| `reversal` | RSI背离 + 支撑反弹 | 中 SL (1.5x ATR) | 前装 50/30/20，快速锁利 | 可 DCA (最多2层) |
| `breakout` | 突破 + 放量确认 | 窄 SL (1.2x ATR)，跌破突破位就走 | 均衡 40/30/30 | 不 DCA |
| `scalp` | 资金费率反转 / 流动性扫荡 | 紧 SL (1.0x ATR) | 重前装 60/40，快进快出 | 不 DCA |

### 映射逻辑

```
Entry Trigger Type        + Regime        → Profile
─────────────────────────────────────────────────────
bullish_confirmation      + trending      → trend
bullish_confirmation      + ranging       → reversal
support_bounce            + any           → reversal
bos_pullback              + trending      → trend
bos_pullback              + ranging       → breakout
liquidity_sweep           + any           → scalp
breakout (N-bar)          + any           → breakout
funding_rate_reversal     + any           → scalp
```

### 数据流

```
Scanner                    AI                      TradeManager
  │                        │                           │
  ├─ entryTrigger.type ──►│                           │
  ├─ regime ─────────────►│                           │
  ├─ slSource ───────────►│  映射为 profile ──────────►│
  ├─ grade ──────────────►│  决定 GO/NO-GO            │
  │                        │  选择 DCA 参数            │
  │                        │                           ├─ SL 宽度按 profile
  │                        │                           ├─ TP 比例按 profile
  │                        │                           ├─ DCA 按 profile
  │                        │                           └─ 追踪方式按 profile
```

---

## 二、DCA 设计

### 核心原则

1. **只有 `reversal` 画像启用 DCA** — 均值回归逻辑才适合越跌越买
2. **总风险上限不变** — 初始仓位 1%，DCA 加仓 0.5% × 2 层 = 总计最大 2% 权益风险
3. **ATR 锚定加仓位** — 不用固定百分比，用 ATR 倍数确定加仓触发点
4. **加仓后自动调整 TP** — 按新的均价重算 TP 位

### DCA 参数

```typescript
interface DcaConfig {
  enabled: boolean
  maxLayers: number              // 最多加仓几次 (建议 2)
  layerMultipliers: number[]     // 每层加仓金额相对初始仓位的倍数
                                 // e.g. [0.5, 0.5] = 第1层加50%, 第2层再加50%
  triggerAtrMultiples: number[]  // 触发加仓的 ATR 倍数（从入场价算）
                                 // e.g. [1.5, 2.5] = 跌1.5xATR加第1层, 跌2.5xATR加第2层
  hardStopAtrMultiple: number   // 硬止损 ATR 倍数（所有DCA层都用完后的最终止损）
                                 // e.g. 3.5 = 跌3.5xATR全部止损
  tpProfitThreshold: number     // DCA 部分的止盈阈值（利润率）
                                 // e.g. 0.015 = 1.5% 利润就平掉 DCA 部分
}
```

### 默认 DCA 参数（reversal profile）

```
初始仓位: 按 calculatePositionSize 正常计算 (约 1% 风险)
DCA 第1层: 跌 1.5x ATR → 加仓 50% 初始仓位
DCA 第2层: 跌 2.5x ATR → 加仓 50% 初始仓位
硬止损:    跌 3.5x ATR → 全部止损
DCA 止盈:  回到均价 +1.5% → 平掉 DCA 部分（保留原始仓位跑 TP）
```

### 示例：ETH/USDT 做多

```
入场价: $3000, ATR: $60

初始仓位: 0.1 ETH ($300)
DCA 触发1: $3000 - 1.5×$60 = $2910 → 加 0.05 ETH ($145.50)
DCA 触发2: $3000 - 2.5×$60 = $2850 → 加 0.05 ETH ($142.50)
硬止损:    $3000 - 3.5×$60 = $2790 → 全部止损

加仓后均价: ($300 + $145.50 + $142.50) / 0.2 = $2940
DCA 止盈:   $2940 × 1.015 = $2984 → 平掉 DCA 部分 (0.1 ETH)
原始仓位:   0.1 ETH 继续按 TP1/TP2/TP3 管理
```

### DCA 生命周期

```
Plan 创建 (pending)
  │
  ├─ 入场成交 → active
  │     │
  │     ├─ 正常走势 → 按 TP1/2/3 逐级平仓 (无 DCA 发生)
  │     │
  │     ├─ 跌到 DCA 触发1
  │     │     ├─ forceEnter 加仓
  │     │     ├─ 更新 plan.dcaLayers[0].filled = true
  │     │     ├─ 重算均价 → 调整 TP
  │     │     │
  │     │     ├─ 回涨到 DCA 止盈阈值
  │     │     │     └─ 平掉 DCA 部分，保留原始仓位
  │     │     │
  │     │     └─ 继续跌到 DCA 触发2
  │     │           ├─ forceEnter 再次加仓
  │     │           └─ ...同上逻辑
  │     │
  │     └─ 跌到硬止损 → forceExit 全部 → completed
  │
  └─ DCA 全部止盈后 → 原始仓位继续按正常 TP/SL 管理
```

---

## 三、TradePlan 类型扩展

```typescript
// types.ts 新增

type TradeProfile = 'trend' | 'reversal' | 'breakout' | 'scalp'

interface DcaLayer {
  /** 层号，从 1 开始 */
  layer: number
  /** 触发价格 */
  triggerPrice: number
  /** 加仓金额 (USDT) */
  stakeAmount: number
  /** 状态 */
  status: 'pending' | 'triggered' | 'filled' | 'exited' | 'stopped'
  /** 成交价 */
  filledPrice?: number
  /** 成交数量 (coins) */
  filledAmount?: number
  /** 成交时间 */
  filledAt?: string
  /** 退出价 */
  exitPrice?: number
  /** 退出时间 */
  exitAt?: string
}

// TradePlan 新增字段
interface TradePlan {
  // ...existing fields...

  /** 交易画像 — 决定 SL/TP/DCA 策略 */
  profile?: TradeProfile

  /** DCA 配置 */
  dca?: {
    enabled: boolean
    maxLayers: number
    hardStopPrice: number           // ATR 计算的硬止损
    tpProfitThreshold: number       // DCA 部分止盈阈值
    layers: DcaLayer[]
    /** 所有 DCA 层的总加仓数量 */
    totalDcaAmount?: number
    /** DCA 后的综合均价 */
    avgEntryPrice?: number
  }
}
```

---

## 四、Profile 对 SL/TP 的影响

### SL 宽度系数（乘以基础 ATR 倍数）

```typescript
const PROFILE_SL_FACTOR: Record<TradeProfile, number> = {
  trend:    1.3,   // 宽松 — 给趋势呼吸空间
  reversal: 1.0,   // 标准 — DCA 兜底
  breakout: 0.8,   // 偏紧 — 跌破结构就走
  scalp:    0.7,   // 最紧 — 快进快出
}
```

### TP 比例

```typescript
const PROFILE_TP_RATIOS: Record<TradeProfile, [number, number, number]> = {
  trend:    [0.25, 0.35, 0.40],  // 重后装，让利润跑
  reversal: [0.50, 0.30, 0.20],  // 重前装，快锁利
  breakout: [0.40, 0.30, 0.30],  // 均衡
  scalp:    [0.60, 0.40, 0.00],  // 只有2级TP，快出
}
```

### 追踪止损

```typescript
const PROFILE_TRAILING: Record<TradeProfile, TrailingStopConfig | null> = {
  trend:    { type: 'chandelier', distance: 2.5, lookbackBars: 14 },  // 必开
  reversal: null,                                                      // 不追踪，靠 DCA
  breakout: { type: 'chandelier', distance: 3.0, lookbackBars: 10 },  // 宽松追踪
  scalp:    { type: 'percent', distance: 1.0 },                        // 紧追踪
}
```

### Progressive Protection 阶段调整

```typescript
// trend: 更宽松的阶梯（给空间）
const PROGRESSIVE_STAGES_TREND: [number, number][] = [
  [4.0, 2.5],  // +4.0x ATR → lock +2.5x
  [3.0, 1.5],  // +3.0x → lock +1.5x
  [2.0, 0.5],  // +2.0x → lock +0.5x
  [1.5, 0.0],  // +1.5x → breakeven
]

// reversal: 标准阶梯（当前默认）
const PROGRESSIVE_STAGES_REVERSAL = PROGRESSIVE_STAGES_DEFAULT

// breakout: 更紧的阶梯（快锁利）
const PROGRESSIVE_STAGES_BREAKOUT: [number, number][] = [
  [3.0, 2.0],  // +3.0x → lock +2.0x
  [2.0, 1.0],  // +2.0x → lock +1.0x
  [1.2, 0.0],  // +1.2x → breakeven
  [0.8, -0.3], // +0.8x → cut risk
]

// scalp: 最紧（保护优先）
const PROGRESSIVE_STAGES_SCALP: [number, number][] = [
  [2.0, 1.5],
  [1.5, 1.0],
  [1.0, 0.0],  // +1.0x ATR 就保本
  [0.5, -0.3],
]
```

---

## 五、实施计划

### P0: Signal Profile 基础（影响所有新交易）

**P0-1: TradePlan 类型扩展**
- `types.ts`: 新增 `TradeProfile`, `DcaLayer`, `DcaConfig` 类型
- `TradePlan` 新增 `profile?` 和 `dca?` 字段

**P0-2: Profile 映射函数**
- `entry-trigger.ts` 或新文件: `mapToProfile(triggerType, regime) → TradeProfile`
- Scanner 返回的 `PipelineSignal` 新增 `profile` 字段

**P0-3: Profile 驱动 SL/TP 参数**
- `entry-trigger.ts`: `dynamicSlMultiplier` 接受 `profile` 参数
- `entry-trigger.ts`: `tpRatios` 接受 `profile` 参数（优先级高于 regime）
- 这两个函数已经存在，只需加 profile 覆盖

**P0-4: adapter.ts 工具更新**
- `cryptoCreateTradePlan` 新增可选 `profile` 参数
- AI 可指定 profile，或由 Scanner 信号自动推断

### P1: DCA 实现（仅 reversal profile）

**P1-1: DCA 层计算**
- `TradeManager.ts`: `computeDcaLayers(plan)` — 根据入场价 + ATR 计算触发价和加仓金额
- 在 `handlePending` 中入场成交后调用

**P1-2: DCA 触发执行**
- `TradeManager.ts`: `checkDcaTriggers(plan, currentPrice)` — 每 tick 检查
- 触发后调用 `freqtrade.forceEnter()` 加仓
- 更新 `plan.dca.layers[i].status`, 重算均价

**P1-3: DCA 止盈**
- `TradeManager.ts`: `checkDcaTakeProfit(plan, currentPrice)` — DCA 部分回本+阈值时平掉
- 调用 `freqtrade.forceExit()` 平掉加仓数量
- 原始仓位继续按 TP1/2/3 管理

**P1-4: DCA 硬止损**
- 融入现有 `checkSlBreach()` — 如果有 DCA 且触发硬止损，全部平仓

### P2: Profile 驱动高级行为

**P2-1: Profile 驱动 progressive protection 阶梯**
- 不同 profile 使用不同阶梯参数

**P2-2: Profile 驱动 trailing stop 自动配置**
- `trend` profile 自动启用 chandelier trailing
- 其他 profile 按配置表

**P2-3: AI 系统提示词更新**
- 让 AI 理解 profile 系统，在交易提案中说明为什么选择某个 profile

---

## 六、风险控制

### DCA 风险限制

| 限制 | 值 | 说明 |
|------|-----|------|
| DCA 总仓位上限 | 初始仓位 × 2.0 | 最多翻倍 |
| DCA 总权益风险 | ≤ 3% | 含初始仓位 |
| DCA 最大层数 | 2 | 不贪 |
| DCA 硬止损 | 3.5x ATR | 不可调 |
| 仅限 reversal profile | 强制 | trend/breakout/scalp 不 DCA |
| Grade 要求 | A 或 B | C 级信号不开 DCA |

### 与现有 Guard 集成

- `MaxPositionSizeGuard`: 需要感知 DCA 加仓，计入总仓位
- `MaxOpenTradesGuard`: DCA 加仓不算新仓位（是同一个 trade）
- `MinBalanceGuard`: DCA 前检查余额是否足够

---

## 七、不做的事情

1. **不做无限 DCA** — NFIX7 的 rebuy mode 止损设为 100%，我们不抄
2. **不做 grind 模式** — 6 层 grind + derisk 太复杂，2 层 DCA 足够
3. **不做固定百分比触发** — 用 ATR 锚定，适应不同波动率的币
4. **profile 不影响入场决策** — 只影响仓位管理，入场仍由 Scanner + AI 决定
