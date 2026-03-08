# Improvement Plan v6 — 安全修复 + 可配置化 + 边界条件

> Created: 2026-03-08

## P0 — 逻辑安全问题

### P0-1: EmotionGuard 未知情绪默认放行 (全仓)
- **文件:** `src/extension/crypto-trading/guards/emotion-guard.ts:43-51`
- **问题:** `matchEmotion()` 未匹配任何关键词时返回 `multiplier: 1.0`，等同于"自信"状态
- **风险:** AI 情绪字符串拼错（如 "nervus"）→ 不触发任何缩仓 → 全仓下单
- **修复:** 未知情绪默认返回保守 multiplier (0.5)，并在 reason 中标注 "unknown emotion"
- **状态:** ✅ Done

### P0-2: TP 出场大小无校验
- **文件:** `src/extension/crypto-trading/trade-manager/TradeManager.ts:1446-1499`
- **问题:** TP exit size = `positionValue * level.sizeRatio`，不检查剩余持仓
- **风险:** TP1 出 50% 后仓位被部分清算，TP2 尝试卖超过实际持仓量 → 交易所拒单或反向开仓
- **修复:** TP 下单前 clamp size 为 min(计算量, 剩余持仓量)
- **状态:** ✅ Done

### P0-3: CooldownGuard 重启后冷却归零
- **文件:** `src/extension/crypto-trading/guards/guard-pipeline.ts:127-158`
- **问题:** `lastTradeTime` 存在内存 Map 中，服务重启即清空
- **风险:** 重启后所有 symbol 立刻可交易，5 分钟冷却窗口失效
- **修复:** 冷却时间持久化到文件 (`data/state/cooldown.json`)，启动时恢复
- **状态:** ✅ Done

## P1 — 硬编码可配置化

### P1-1: DCA 配置硬编码
- **文件:** `src/extension/crypto-trading/trade-manager/TradeManager.ts:125-131, 762`
- **问题:** `maxLayers=2`, `tpProfitThreshold=0.015`, `DCA_TRIGGER_ATR_MULTIPLES=[1.5]` 全部硬编码
- **修复:** 新增 `data/config/dca.json`，TradeManager 启动时读取
- **状态:** ✅ Done

### P1-2: Entry Trigger 参数硬编码
- **文件:** `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts:33-108`
- **问题:** SL 乘数、TP 分仓比例、R:R 最低阈值全部写死
- **修复:** 新增 `data/config/entry-trigger.json`，函数读取配置并 fallback 到当前默认值
- **状态:** ✅ Done

### P1-3: Kelly 参数硬编码
- **文件:** `src/extension/archive-analysis/adapter.ts:38-57`
- **问题:** win rate 范围 (0.45-0.55)、Kelly 分数 (1/5)、risk 上下限 (0.5%-3%) 写死
- **修复:** 新增 `data/config/kelly.json`
- **状态:** ✅ Done

### P1-4: Mean-reversion token 列表写死
- **文件:** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts:148-153`
- **问题:** `MEAN_REVERSION_TOKENS` Set 固定 8 个币，新 meme 币无法覆盖
- **修复:** 从 `data/config/tokens.json` 读取 mean-reversion 列表
- **状态:** ✅ Done

### P1-5: Pending Zone TTL 固定 4 小时
- **文件:** `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts:463`
- **问题:** TTL 固定 4h，ranging 市场可能需要 8-12h，trending 市场 1-2h 就够
- **修复:** TTL 按 regime 动态调整（纳入 entry-trigger.json 配置）
- **状态:** ✅ Done

## P2 — 边界条件

### P2-1: 低价币 SL 低于交易所最小精度
- **文件:** `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts`
- **问题:** SHIB/PEPE 等低价币 0.5×ATR 可能是 $0.000001，低于交易所最小精度
- **修复:** SL 距离增加绝对最小值 floor（如 entry price × 0.3%）
- **状态:** ✅ Done

### P2-2: Regime null/undefined 静默降级
- **文件:** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts:32-36`
- **问题:** regime 为 null 时所有 `regime==='uptrend'` 判断为 false，静默按 ranging 处理
- **修复:** 显式检查 null，log warning，标记 score 置信度降低
- **状态:** ✅ Done

### P2-3: TradeManager 无 pending plan 上限
- **文件:** `src/extension/crypto-trading/trade-manager/TradeManager.ts:86-137`
- **问题:** `addPlan()` 不检查已有 plan 数量，可无限积累
- **修复:** 增加上限（如 20），超出时拒绝并提示清理
- **状态:** ✅ Done

### P2-4: AccountDrawdown UTC 午夜重置偏移
- **文件:** `src/extension/crypto-trading/guards/account-drawdown-guard.ts:21-38`
- **问题:** 以 UTC 00:00 为日界线，对 UTC+8 用户实际是早上 8 点重置
- **修复:** 从 config 读取 timezone offset，按用户本地时间重置
- **状态:** ✅ Done
