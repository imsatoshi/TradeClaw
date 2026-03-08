# Improvement Plan v7 — 深度审计修复 + OpenAlice 借鉴

> Created: 2026-03-08

## CRITICAL — 必须立即修复

### ~~C1: MACD histogram 数组越界~~ — 误报
- **文件:** `src/extension/analysis-kit/tools/strategy-scanner/helpers.ts`
- **验证:** fastEma[i+offset] 最大索引 = closesLen-fast = fastEma.length-1，不会越界
- **状态:** ❌ 非问题

### C2: 短仓 trailing stop 缺最小距离保护
- **文件:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`
- **问题:** Long 有 2.5% peakPrice 最小距离，Short 被跳过（注释 "skip for now"）
- **影响:** 空头价格尖刺时 SL 被错误收紧 → 被扫损
- **修复:** 为 Short 添加对称的最小距离保护
- **状态:** ✅ Done

### C3: CooldownGuard 在执行前记录交易时间
- **文件:** `src/extension/crypto-trading/guards/guard-pipeline.ts`
- **问题:** `lastTradeTime.set()` 在 check() 中执行，订单失败也会触发冷却
- **影响:** 失败订单阻止正常重试
- **修复:** 移除 check() 中的记录，新增 `recordTrade(symbol)` 方法供执行成功后调用
- **状态:** ✅ Done

## HIGH — 近期修复

### H1: crypto.json 硬编码 Freqtrade 凭证
- **文件:** `data/config/crypto.json`
- **问题:** username/password 明文写在 config 文件中
- **修复:** 改为从 process.env 读取 FREQTRADE_USERNAME / FREQTRADE_PASSWORD
- **状态:** ✅ Done

### H2: 调度器无执行超时
- **文件:** `src/core/scheduler.ts`
- **问题:** runOnce() 无超时，Freqtrade API 挂起会阻塞调度器
- **修复:** Promise.race([runOnce(), timeout(120s)])
- **状态:** ✅ Done

### H3: Guards 不检查杠杆倍数
- **文件:** `src/extension/crypto-trading/guards/guard-pipeline.ts`
- **问题:** MaxPositionSizeGuard 检查名义价值但不考虑杠杆
- **修复:** 在 guard 中获取杠杆倍数，用名义价值/杠杆计算实际保证金占比
- **状态:** ✅ Done

### H4: 交易工具无 rate limit
- **文件:** `src/extension/crypto-trading/operation-dispatcher.ts`
- **问题:** AI 可能短时间内下大量订单
- **修复:** 添加滑动窗口 rate limiter（10 单/分钟）
- **状态:** ✅ Done

### H5: 内存缓存无上限
- **文件:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`
- **问题:** pnlCache/atrCache 永不清理
- **修复:** 添加 TTL 或 max-size 限制，定期清理过期条目
- **状态:** ✅ Done

### H6: Volume 评分逻辑错误
- **文件:** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts`
- **问题:** ranging 模式下 volume ratio 条件判断有重叠
- **修复:** 修正条件分支
- **状态:** ✅ Done

### H7: 外部平仓不恢复 P&L
- **文件:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`
- **问题:** reconcile() 发现外部平仓时直接标 error，不记录最终 P&L
- **修复:** 从 trade 对象获取 close_profit 并记入 plan
- **状态:** ✅ Done

## OpenAlice 借鉴

### OA1: EventLog 分页查询
- **修复:** 添加 query(page, pageSize, type?) 方法
- **状态:** ✅ SKIP — 已有 cursor-based 分页（afterSeq + limit）

### OA2: 结构化心跳协议
- **修复:** 心跳响应用 STATUS/CONTENT 结构化解析
- **状态:** ⬜ DEFERRED — 非紧急，等需要 dashboard 自动化时再做

### OA3: Runtime Provider 热切换
- **修复:** ProviderRouter 每次调用读 ai-provider.json
- **状态:** ✅ SKIP — ProviderRouter 已实现热切换，每次 ask() 读取最新 config

### OA4: CCXT 后台初始化
- **修复:** main.ts 启动任务并行化（Promise.all）
- **状态:** ✅ Done
