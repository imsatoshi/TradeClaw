# TradeClaw Improvement Plan v3

> Generated: 2026-03-08 | Status: In Progress

## Overview

Post-v2 codebase audit focusing on data safety, resilience, and correctness.

---

## P0 — Data Safety

### P0-1: Atomic File Writes in TradePlanStore
**Problem:** `store.ts` uses `writeFile()` directly. Process crash during write = empty/corrupted file = all active plans lost.
**Fix:** Write to temp file, then atomic rename (same pattern as `cron.ts`).
**Files:** `src/extension/crypto-trading/trade-manager/store.ts`

### P0-2: Guard Pipeline Exception Safety
**Problem:** `guard.check()` has no try-catch. A throwing guard crashes the entire trade operation instead of blocking gracefully.
**Fix:** Wrap each `guard.check()` in try-catch; treat exceptions as `{ allowed: false }` with error context.
**Files:** `src/extension/crypto-trading/guards/guard-pipeline.ts`

---

## P1 — Resilience

### P1-1: Reconcile Error Isolation
**Problem:** `reconcile()` in `tick()` has no try-catch. If `store.archive()` fails, it triggers the circuit breaker.
**Fix:** Wrap `reconcile()` call in try-catch inside `tick()`.
**Files:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`

### P1-2: Compaction Failure Exponential Backoff
**Problem:** 5-minute flat cooldown after LLM compaction failure. If LLM is down for hours, retries every 5 min.
**Fix:** Exponential backoff: 5m → 15m → 60m → 4h cap.
**Files:** `src/core/compaction.ts`

### P1-3: PnL Cache Defensive Cleanup
**Problem:** `pnlCache.delete()` only runs after `store.archive()`. If archive throws, cache leaks.
**Fix:** Move `pnlCache.delete()` before `store.archive()`, or add periodic sweep.
**Files:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`

---

## Implementation Order

```
P0-1 → P0-2 → P1-1 → P1-2 → P1-3
```

## Expected Outcomes

- **Data safety:** Eliminates plan file corruption risk
- **Resilience:** Guard failures degrade gracefully, compaction doesn't retry-spam
- **Memory:** No PnL cache leaks from failed archive operations
