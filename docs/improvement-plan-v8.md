# Improvement Plan v8 — 可靠性 & 健壮性加固

> Created: 2026-03-08

## 启动优化

### OA4: 启动任务并行化
- **文件:** `src/main.ts`
- **问题:** crypto engine / OHLCV / wallet / brain / persona 顺序 await，浪费 2-5s
- **修复:** 独立任务用 Promise.all() 并行执行
- **状态:** ✅ Done

## 网络健壮性

### N1: Freqtrade fetch 超时
- **文件:** `src/extension/crypto-trading/providers/freqtrade/FreqtradeTradingEngine.ts`
- **问题:** 所有 fetch() 无超时，API 挂起永久阻塞
- **修复:** 4 个 HTTP helper（get/post/deleteWithBody/delete）加 `AbortSignal.timeout(30_000)`
- **状态:** ✅ Done

## 错误处理

### N2: onCommit 回调异常保护
- **文件:** `Wallet.ts`, `Brain.ts`
- **问题:** onCommit 回调抛异常会向上传播导致主流程崩溃
- **修复:** try-catch 包裹，log error 但不传播
- **状态:** ✅ Done

### N3: JSON 状态文件损坏保护
- **文件:** `main.ts`, `TradeMemory.ts`
- **问题:** JSON.parse 损坏文件直接崩溃，无恢复机制
- **修复:** parse 失败时 log warning，rename 为 .corrupted，fallback 空状态
- **状态:** ✅ Done

## 资源泄漏

### N4: Scheduler timeout 清理
- **文件:** `src/core/scheduler.ts`
- **问题:** runOnce 成功后 setTimeout 未 clear，泄漏 timer
- **修复:** 存储 timeoutId，Promise.race 结束后 clearTimeout
- **状态:** ✅ Done

## 数据完整性

### N5: session.ts 原子写入
- **文件:** `src/core/session.ts`
- **问题:** truncateTo() 非原子操作，crash 可导致 JSONL 文件损坏
- **修复:** 写临时文件 → renameSync 原子替换
- **状态:** ✅ Done

## 性能优化

### N6: Brain 去重 commit
- **文件:** `src/extension/brain/Brain.ts`
- **问题:** 相同内容重复调用 updateFrontalLobe/updateEmotion 会产生冗余 commit
- **修复:** 写入前对比当前状态，内容不变则 skip
- **状态:** ✅ Done

### N7: BoundedCache get 时 TTL 检查
- **文件:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`
- **问题:** evict 仅在 set 时触发，过期条目在读取时不被清除
- **验证:** get() 已包含 TTL 检查，无需修改
- **状态:** ✅ SKIP — 已实现
