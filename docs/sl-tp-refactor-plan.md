# SL/TP 重构计划

基于历史交易分析和业界最佳实践，重构 TradeManager 的止损/止盈管理系统。

## 问题总结

1. SL 通过 CCXT 下 STOP_MARKET 单，dry-run 下不触发，maxDD 远超 SL 距离
2. AI 自己编 SL/TP 价格，出现 SL 在入场价上方等离谱情况
3. 12 笔交易只有 2 笔 TP1 成交（16.7%），TP 太远
4. autoBreakeven 依赖 TP1 成交，但 TP1 打不到，形成死循环
5. 没有渐进式保护，浮盈全部回吐

---

## P0-1: SL 改为价格监控 + forceExit

**目标**: 废掉 CCXT 止损单，TradeManager 自己监控价格，到价后通过 Freqtrade forceExit 平仓

**文件改动**:
- `src/extension/crypto-trading/trade-manager/types.ts`
  - StopLoss.status 增加 `'monitoring'`，移除 `'placed'` 的语义（保留兼容但不再使用）
  - StopLoss 移除 `orderId` 字段（SL 不再通过交易所下单）
- `src/extension/crypto-trading/trade-manager/TradeManager.ts`
  - `placeStopLoss()`: 不再调用 directEngine，改为仅设置 status='monitoring'
  - `checkSlBreach()`: 已有（上次加的），确认逻辑正确，作为唯一 SL 执行机制
  - `applyAutoBreakeven()`: 移除取消 CCXT order 的代码，仅更新 price + status
  - `applyTrailingStop()`: 同上
  - `applyTimeDecay()`: 同上
  - `cancelPlan()`: 移除取消 CCXT SL order 的代码
  - `updatePlan()`: 同上
  - `handlePending()`: placeStopLoss 调用保留，但内部已改为纯状态设置
- `src/extension/crypto-trading/trade-manager/store.ts`
  - `load()`: 迁移旧数据 — status='placed' 的 SL 自动改为 'monitoring'

**验证**: 单元测试确认 checkSlBreach 在价格穿越 SL 时 forceExit

---

## P0-2: SL/TP 合理性校验

**目标**: cryptoCreateTradePlan 入场时拒绝不合理的 SL/TP

**文件改动**:
- `src/extension/crypto-trading/trade-manager/TradeManager.ts` 的 `addPlan()`
  - 增加校验（入场后在 handlePending 中执行，因为此时才有 entryPrice）:
    1. SL 方向: long 时 SL 必须 < entryPrice，short 时 SL 必须 > entryPrice
    2. SL 距离: 0.5% ~ 15%（山寨币波动大，上限放宽）
    3. TP1 方向: long 时 TP1 必须 > entryPrice，short 时 TP1 必须 < entryPrice
    4. R:R >= 1.0（TP1 距离 / SL 距离）
  - 校验失败 → forceExit + 标记 plan 为 error + 发事件通知 AI
- `src/extension/crypto-trading/trade-manager/adapter.ts`
  - tool description 中增加 SL/TP 规则说明，引导 AI 给合理值

**验证**: 单元测试 — SL 在入场错误方向时拒绝，SL 太远/太近时拒绝

---

## P1-1: 渐进式 SL 保护（Progressive Protection）

**目标**: 根据浮盈阶梯式收紧 SL，不依赖 TP 成交

**文件改动**:
- `src/extension/crypto-trading/trade-manager/TradeManager.ts`
  - 新增 `applyProgressiveProtection(plan, currentPrice, atr)`
  - 在 processPlan() 的 tick 循环中调用，在 applyAutoBreakeven 之前
  - 阶梯逻辑（基于 ATR 倍数）:
    | 浮盈阈值 | SL 移到 |
    |----------|---------|
    | +1.0x ATR | entry - 0.5x ATR（降 50% 风险）|
    | +1.5x ATR | entry（保本）|
    | +2.5x ATR | entry + 1.0x ATR（锁利）|
    | +3.5x ATR | entry + 2.0x ATR |
  - 需要 ATR 数据 → 复用 ExchangeClient.fetchExchangeOHLCV + helpers.atrSeries
  - ATR 缓存: symbol → { atr, updatedAt }，每 5 分钟刷新一次
- `src/extension/crypto-trading/trade-manager/types.ts`
  - TradePlan 新增 `progressiveStage?: number`（记录当前阶段，避免重复触发）
  - TradePlan 新增 `atrAtEntry?: number`（入场时的 ATR，用于计算阶梯）

**数据来源**:
- 复用 `src/extension/archive-analysis/data/ExchangeClient.ts` 的 fetchExchangeOHLCV
- 复用 `src/extension/analysis-kit/tools/strategy-scanner/helpers.ts` 的 atrSeries

**验证**: 单元测试 — 各阶段 SL 正确移动，ATR 缓存逻辑

---

## P1-2: System Prompt 约束 AI 调整边界

**目标**: AI 只能在 Scanner 基准上做有限调整，不能瞎编数字

**文件改动**:
- `src/main.ts` system prompt
  - 在交易 workflow 部分增加硬性规则:
    ```
    SL/TP 规则（强制执行）:
    1. 必须使用 Scanner 信号中的 SL/TP 作为基准
    2. 可以收紧 SL（更保守），最多收 30%，不能放宽
    3. 可以调整 TP，±20% 范围内
    4. 调整后 R:R 必须 >= 1.5
    5. 不能自己编 SL/TP 价格，必须基于 Scanner 基准
    6. 如果 Scanner 没有 entry trigger，不要自己找入场点
    ```
  - 修改 "you are the strategy brain" 的措辞，强调 AI 是决策者不是数字计算者

**验证**: 手动观察 — 下一次 heartbeat 时 AI 是否遵循规则

---

## P2-1: TP 分批比例根据趋势/震荡调整

**目标**: 趋势市让 runner 跑更久，震荡市先锁利

**文件改动**:
- `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts`
  - computeStructureTPs() 接受 regime 参数
  - 趋势市: 30/30/40（TP3 比例最大）
  - 震荡市: 50/30/20（TP1 比例最大）
  - 默认: 40/30/30（当前值）
- `src/extension/analysis-kit/tools/strategy-scanner/scanner.ts`
  - 传入 regime 到 checkEntryTrigger / computeStructureTPs

**验证**: 单元测试 — 不同 regime 下 TP 比例正确

---

## P2-2: ATR 乘数微调

**目标**: "正常"波动的 SL 乘数从 1.5→1.8，加入趋势/震荡修正

**文件改动**:
- `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts`
  - `dynamicSlMultiplier()`:
    - volRatio > 3.0 → 2.5（不变）
    - volRatio > 2.0 → 2.0（不变）
    - volRatio > 1.0 → 1.8（原 1.5）
    - volRatio <= 1.0 → 1.3（原 1.2）
  - 增加 regime 修正: 趋势市 x1.2，震荡市 x0.85
  - `dynamicSlMultiplier(atr, price)` → `dynamicSlMultiplier(atr, price, regime?)`

**验证**: 单元测试 — 各 regime 下乘数正确

---

## P2-3: Chandelier 风格 trailing stop

**目标**: 用周期最高/低价做锚点的 trailing stop，替代简单固定距离 trailing

**文件改动**:
- `src/extension/crypto-trading/trade-manager/types.ts`
  - TrailingStopConfig.type 增加 `'chandelier'`
  - 新增可选字段 `atrMultiplier?: number`（默认 2.5）
  - 新增可选字段 `lookbackBars?: number`（默认 14）
- `src/extension/crypto-trading/trade-manager/TradeManager.ts`
  - `applyTrailingStop()` 增加 chandelier 分支:
    1. 获取最近 N 根 K 线的最高价（long）/ 最低价（short）
    2. SL = periodHigh - atrMultiplier * ATR（long）
    3. SL = periodLow + atrMultiplier * ATR（short）
    4. 只往有利方向移，不回退
  - 需要 K 线数据 → 复用 ATR 缓存 + OHLCV 缓存

**验证**: 单元测试 — chandelier trailing 在趋势中正确跟踪

---

## 执行顺序

```
P0-1 (SL 价格监控)  →  P0-2 (SL/TP 校验)
        ↓
P1-1 (渐进式保护)  →  P1-2 (prompt 约束)
        ↓
P2-1 (TP 比例调整)  →  P2-2 (ATR 乘数)  →  P2-3 (Chandelier trailing)
```

每个改动完成后跑测试，确认无回归再进入下一个。
