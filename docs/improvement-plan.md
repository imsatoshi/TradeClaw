# TradeClaw 改进计划

基于 TradeClaw vs OpenAlice 全面对比，按优先级排列的改进方案。

---

## P0 — 立刻能带来价值

### P0-1: 指数退避重试 + 错误恢复

**问题**: 心跳调 API 失败后无限 retry，刷屏死循环；初始化无退避。

**方案**:

```
scheduler.ts:
  - flush() 失败后，retry 次数递增: 1s → 2s → 4s → 8s → 16s → 30s (cap)
  - 连续失败 5 次后暂停该 wake reason，等下一个 interval 自然触发
  - 新增 retryCount 状态，成功后重置

ExchangeClient.ts / FreqtradeTradingEngine.ts:
  - fetchWithRetry(fn, maxRetries=3, baseDelayMs=1000)
  - 指数退避: delay = baseDelay * 2^attempt
  - 区分 transient (网络超时) vs permanent (invalid symbol) 错误
```

**改动文件**:
- `src/core/scheduler.ts` — flush 退避逻辑
- `src/core/retry.ts` — 新建通用 retry 工具函数
- `src/extension/archive-analysis/data/ExchangeClient.ts` — 用 retry 包装
- `src/extension/crypto-trading/providers/freqtrade/FreqtradeTradingEngine.ts` — 用 retry 包装

**验证**: 断开网络 → 观察日志递增间隔，恢复后正常运行。

---

### P0-2: 决策前推理工具 (thinkBeforeTrade)

**问题**: AI 直接下单/提案，没有强制推理步骤，容易冲动交易。

**方案**:

```typescript
// 新工具: thinkBeforeTrade
// AI 在调用 proposeTradeWithButtons 之前 MUST 先调用此工具

interface ThinkBeforeTradeInput {
  symbol: string
  direction: 'long' | 'short'
  edge: string           // "我押注什么？" — e.g. "RSI 超卖反弹 + 成交量确认"
  risk: string            // "什么会让我亏钱？" — e.g. "假反弹继续下跌"
  confidence: number      // 0-100 信心度
  scannerGrade: string    // Scanner 给的评级 (A/B/C)
  aiOverride?: string     // AI 是否覆盖 scanner 评分？为什么？
  checklist: {
    positionSizeOk: boolean
    newsChecked: boolean
    noRecentLoss: boolean  // 最近 2 小时内同 symbol 没有亏损
  }
}

// 返回: { approved: boolean, reason: string }
// confidence < 60 → blocked, 返回 "信心不足，建议观望"
// checklist 任一 false → blocked
// 通过 → 记录到 event log，允许继续提案
```

**系统 prompt 修改**:
```
## MANDATORY DECISION PROTOCOL
Before ANY trade proposal, you MUST call thinkBeforeTrade first.
Skipping this step is FORBIDDEN. The tool will block low-confidence trades.
```

**改动文件**:
- `src/extension/crypto-trading/tools/think-before-trade.ts` — 新建
- `src/main.ts` — 注册工具 + 修改 system prompt
- `src/core/event-log.ts` — 记录推理日志

---

### P0-3: Portfolio Dashboard

**问题**: 没有可视化界面看持仓、PnL、交易历史。

**方案**:

```
新增 UI 页面: /portfolio

左侧概览卡片:
┌─────────────────────────────────────┐
│ Total Equity: $12,345.67            │
│ Available Balance: $8,234.12        │
│ Unrealized PnL: +$234.56 (+1.9%)   │
│ Realized PnL (today): -$45.23      │
│ Open Positions: 3 / 5              │
└─────────────────────────────────────┘

持仓表格:
┌────────┬──────┬────────┬────────┬─────────┬───────┐
│ Symbol │ Side │ Entry  │ Mark   │ uPnL    │ SL/TP │
├────────┼──────┼────────┼────────┼─────────┼───────┤
│ BTC    │ LONG │ 95200  │ 95800  │ +$120   │ ✅/✅ │
│ ETH    │ SHORT│ 3200   │ 3150   │ +$50    │ ✅/⏳ │
└────────┴──────┴────────┴────────┴─────────┴───────┘

活跃交易计划:
┌─────────────────────────────────────────────────────┐
│ Plan: BTC LONG (active)                             │
│ Entry: $95200 | TP1: $96000 (40%, placed)           │
│ TP2: $97500 (30%, pending) | TP3: $99000 (30%)     │
│ SL: $94000 (placed) | R:R 2.3 | uPnL: +$120       │
│ Auto-BE: ON | Trailing: OFF                         │
└─────────────────────────────────────────────────────┘

底部: 最近交易历史 (从 trade-plans/history.json 读取)
```

**后端 API**:
```
GET /api/portfolio
  → { equity, balance, unrealizedPnl, positions[], activePlans[], recentHistory[] }

// 从 FreqtradeTradingEngine + TradeManager 聚合数据
// 30 秒自动刷新
```

**改动文件**:
- `ui/src/pages/PortfolioPage.tsx` — 新建前端页面
- `ui/src/App.tsx` — 注册路由
- `src/connectors/http/routes/portfolio.ts` — 新建 API 路由
- `src/connectors/http/plugin.ts` — 挂载路由

---

## P1 — 提升交易质量

### P1-1: 信心评分 + 自动/手动执行分级

**问题**: 所有提案都需要用户手动确认，高信心 setup 应该可以自动执行。

**方案**:

```
信心分级:
  ≥ 80 + Grade A → 自动执行 (如果 config 允许)
  60-79           → 发 Telegram 确认按钮
  < 60            → 被 thinkBeforeTrade 阻止

配置: data/config/auto-trade.json
{
  "enabled": false,        // 默认关闭，用户手动开启
  "minConfidence": 80,
  "minGrade": "A",
  "maxAutoUsdSize": 500,   // 自动交易最大 USD 金额
  "notifyOnAuto": true     // 自动成交后通知用户
}
```

**改动文件**:
- `src/extension/crypto-trading/auto-execute.ts` — 新建自动执行逻辑
- `src/extension/crypto-trading/tools/think-before-trade.ts` — 输出 confidence 联动
- `data/config/auto-trade.json` — 新建配置文件

---

### P1-2: 情绪-仓位联动

**问题**: Brain 追踪情绪但不影响实际交易行为。

**方案**:

```typescript
// 在 Guard Pipeline 中新增 EmotionGuard

class EmotionGuard implements Guard {
  // 读取 brain/emotion 状态
  // 根据情绪调整允许的最大仓位比例:
  //   confident → 100% (正常)
  //   neutral   → 100% (正常)
  //   cautious  → 50%  (半仓)
  //   scared    → 25%  (1/4 仓)
  //   angry     → 0%   (禁止交易)

  check(ctx: GuardContext): GuardResult {
    const emotion = readCurrentEmotion()
    const multiplier = EMOTION_MULTIPLIER[emotion]
    if (multiplier === 0) return { allowed: false, reason: `情绪状态 ${emotion}，暂停交易` }
    // 修改 ctx.operation.params.usd_size *= multiplier
    return { allowed: true }
  }
}
```

**改动文件**:
- `src/extension/crypto-trading/guards/emotion-guard.ts` — 新建
- `src/extension/crypto-trading/guards/guard-pipeline.ts` — 注册到默认 guard 链
- `src/extension/brain/tools.ts` — emotion 变更时记录到 event log

---

### P1-3: 交易复盘工具 (tradeReview)

**问题**: 交易结束后只记胜率，不深入分析原因。

**方案**:

```typescript
// 新工具: tradeReview
// TradeManager 在 plan completed/sl_triggered 后，prompt AI 调用此工具

interface TradeReviewInput {
  planId: string
  outcome: 'win' | 'loss' | 'breakeven'
  pnlPercent: number
  whyItWorked: string        // 或 whyItFailed
  whatAlmostWentWrong: string
  keyIndicator: string       // 哪个指标是关键 edge
  wouldRepeat: boolean       // 下次同样情况还会做吗？
  lesson: string             // 1-2 句总结
}

// 存储到 data/trade-reviews/YYYY-MM.jsonl
// 心跳时 AI 可以 query 最近的 review 来学习
```

**改动文件**:
- `src/extension/crypto-trading/tools/trade-review.ts` — 新建
- `src/extension/crypto-trading/trade-manager/TradeManager.ts` — plan 完成后 enqueue review event
- `src/main.ts` — 注册工具 + prompt 中加 review 指令

---

### P1-4: Guard Registry 插件化

**问题**: Guard 硬编码在 `createDefaultGuards()` 里，无法通过配置调整。

**方案**:

```typescript
// data/config/guards.json
{
  "guards": [
    { "name": "MaxPositionSize", "enabled": true, "params": { "maxPercentOfEquity": 40 } },
    { "name": "Cooldown",        "enabled": true, "params": { "minIntervalMs": 60000 } },
    { "name": "MaxOpenTrades",   "enabled": true, "params": { "maxOpenTrades": 5 } },
    { "name": "MinBalance",      "enabled": true, "params": { "minBalanceRatio": 0.3 } },
    { "name": "Emotion",         "enabled": true, "params": {} },
    { "name": "SymbolWhitelist", "enabled": false, "params": { "symbols": [] } }
  ]
}

// Guard Registry: name → constructor mapping
const GUARD_REGISTRY = {
  MaxPositionSize: (p) => new MaxPositionSizeGuard(p),
  Cooldown: (p) => new CooldownGuard(p),
  // ...
}

function createGuardsFromConfig(config): Guard[] {
  return config.guards
    .filter(g => g.enabled)
    .map(g => GUARD_REGISTRY[g.name](g.params))
}
```

**改动文件**:
- `src/extension/crypto-trading/guards/registry.ts` — 新建
- `src/extension/crypto-trading/guards/guard-pipeline.ts` — 重构 createDefaultGuards
- `data/config/guards.json` — 新建配置
- `data/default/guards.default.json` — 默认配置

---

## P2 — 运维改进

### P2-1: 运行时工具开关

**方案**:

```typescript
// data/config/tools.json
{
  "disabled": ["analyzeChart", "browserNavigate"]  // 禁用的工具名
}

// ToolCenter.register() 时检查 disabled 列表
// 配置变更后自动生效 (60s 重新读取)
```

**改动文件**:
- `src/core/tool-center.ts` — 加 disabled 过滤
- `data/config/tools.json` — 新建

---

### P2-2: 日志分页 + 保留策略

**方案**:

```typescript
// EventLog 新增 query 方法
query(opts: { page: number, pageSize: number, level?: string, after?: Date }): EventEntry[]

// 保留策略: data/config/retention.json
{
  "eventLog": { "maxDays": 30 },
  "signalLog": { "maxDays": 90 },
  "tradeReviews": { "maxDays": 365 },
  "newsItems": { "maxDays": 7 }
}

// 每天凌晨清理过期数据 (cron job)
```

**改动文件**:
- `src/core/event-log.ts` — 加分页查询
- `src/core/retention.ts` — 新建清理逻辑
- `src/extension/cron/jobs/` — 注册清理 cron

---

### P2-3: 错误节流

**方案**:

```typescript
// src/core/error-throttle.ts
class ErrorThrottle {
  private seen = new Map<string, number>()  // key → last reported timestamp
  private windowMs = 5 * 60 * 1000         // 5 分钟窗口

  shouldReport(key: string): boolean {
    const last = this.seen.get(key) ?? 0
    if (Date.now() - last < this.windowMs) return false
    this.seen.set(key, Date.now())
    return true
  }
}

// 使用:
if (errorThrottle.shouldReport(`fetch-fail:${symbol}`)) {
  log.warn(`fetch failed for ${symbol}`, { error })
}
```

**改动文件**:
- `src/core/error-throttle.ts` — 新建
- 各调用处引入

---

## 实施顺序

```
Phase 1 (P0): 退避重试 → 推理工具 → Portfolio Dashboard
Phase 2 (P1): 信心分级 → 情绪联动 → 复盘工具 → Guard Registry
Phase 3 (P2): 工具开关 → 日志分页 → 错误节流
```

每个改进独立 commit，可以单独部署验证。
