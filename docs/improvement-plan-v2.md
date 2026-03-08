# TradeClaw Improvement Plan v2

> Generated: 2026-03-08 | Status: In Progress

## Overview

Full-stack analysis by 4 specialized review teams covering:
- Trading engine & guard safety
- TradeManager & DCA system
- Scanner & signal quality
- Infrastructure, scheduler & Telegram

---

## P0 — Critical Safety (Week 1)

### P0-1: Guard Race Condition Fix
**Problem:** Concurrent operations can both pass guards before either executes, bypassing MaxOpenTrades/MaxPositionSize.
**Fix:** Add operation lock in `operation-dispatcher.ts` — serialize guard check + execution as atomic unit.
**Files:** `src/extension/crypto-trading/operation-dispatcher.ts`, `src/extension/crypto-trading/adapter.ts`

### P0-2: TP Placement Retry Logic
**Problem:** If `placeOrder()` fails for a TP level (network timeout), it stays `pending` forever — position only protected by SL.
**Fix:** Add `retryCount` to `TakeProfitLevel`, retry up to 3 times on next ticks, emit alert after exhaustion.
**Files:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`, `types.ts`

### P0-3: Plan Reconciliation on Startup
**Problem:** After restart, plans may reference Freqtrade trades that were closed externally (manual, liquidation). Plans stay `active` forever.
**Fix:** Add `reconcile()` method — on startup + every 5 minutes, verify each plan's `freqtradeTradeId` still exists.
**Files:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`

### P0-4: Account Drawdown Guard
**Problem:** No circuit breaker for losing streaks. Account can lose 20%+ in a day across multiple trades.
**Fix:** New `AccountDrawdownGuard` — track daily equity high watermark, block trades if drawdown exceeds 5% daily / 10% weekly.
**Files:** `src/extension/crypto-trading/guards/account-drawdown-guard.ts`, `data/config/guards.json`

### P0-5: TradeManager Circuit Breaker
**Problem:** `safeTick()` swallows all errors silently. If Freqtrade API is down for hours, plans are unmanaged with no alert.
**Fix:** Track consecutive errors, emit critical alert after 10 failures (~100s), stop tick loop.
**Files:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`

---

## P1 — Signal Quality (Week 2)

### P1-1: Tighten Bullish Confirm Trigger
**Problem:** `0.15×ATR` margin is too tight — triggers on noise. No candle quality check.
**Fix:** Require bullish candle (`close > open`) + previous bar weakness (`close < 40th percentile of range`).
**Files:** `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts` (lines 218-223)

### P1-2: Support Bounce RSI Confirmation
**Problem:** Only checks distance to swing low, not momentum. Bounces at support without oversold condition fail often.
**Fix:** Require RSI < 35 OR volume > 1.5× average at the bounce.
**Files:** `src/extension/analysis-kit/tools/strategy-scanner/entry-trigger.ts` (lines 226-238)

### P1-3: Expose Pending Zones in Heartbeat
**Problem:** AI doesn't know when a high-grade setup is waiting for price pullback to entry zone.
**Fix:** Add pending zones summary to heartbeat prompt: symbol, direction, entry price, expiry.
**Files:** `src/main.ts` (heartbeat construction ~line 690)

### P1-4: Rebalance Structure Dimension Weight
**Problem:** Structure is 20/110 (18%) — dominates composite. FVG/BOS are noisy in ranging markets.
**Fix:** Reduce Structure max from 20 → 15, increase Momentum max from 15 → 20.
**Files:** `src/extension/analysis-kit/tools/strategy-scanner/setup-scorer.ts`

### P1-5: Add Data Freshness to Heartbeat
**Problem:** AI makes decisions on data up to 20 min old (cache TTL) without knowing staleness.
**Fix:** Add "Data age: Xs" and volatility warning (BBWP > 75%) to heartbeat prompt.
**Files:** `src/main.ts`

---

## P2 — Infrastructure & Memory (Week 3)

### P2-1: Session Auto-Trim
**Problem:** Session JSONL files grow unbounded. On 1GB server, causes swapping.
**Fix:** `trimToLastN(200)` on startup per session. Telegram: 300 entries, heartbeat: 50 entries.
**Files:** `src/core/session.ts`, `src/connectors/telegram/telegram-plugin.ts`

### P2-2: Log Noise Reduction
**Problem:** `cron: tick` every 60s, `The Block 403` every 10min — pollute logs, waste I/O.
**Fix:** Suppress cron tick when 0 due jobs. Add error throttle to RSS feed failures.
**Files:** `src/core/cron.ts`, `src/extension/news-collector/`

### P2-3: ErrorThrottle Map Cleanup
**Problem:** `seen` Map never shrinks — unbounded memory growth over months.
**Fix:** Hourly cleanup of entries older than throttle window.
**Files:** `src/core/error-throttle.ts`

### P2-4: Cron Timer Clamp Optimization
**Problem:** 60s clamp creates 1440 setTimeout calls/day even when no jobs are due.
**Fix:** Raise clamp to 300s (5 min) when next job > 5 min away.
**Files:** `src/core/cron.ts`

### P2-5: DCA Hard Stop Safety Check
**Problem:** Hard stop tries to exit main trade that may already be closed externally.
**Fix:** Verify `freqtradeTradeId` exists before `forceExit()`, skip if missing.
**Files:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`

### P2-6: Time Decay Minimum SL Distance
**Problem:** Time decay tightening can push SL below 0.3% minimum distance.
**Fix:** Clamp new SL to maintain ≥ 0.3% distance from entry.
**Files:** `src/extension/crypto-trading/trade-manager/TradeManager.ts`

---

## Implementation Order

```
Week 1 (P0): Guard lock → TP retry → Plan reconciliation → Drawdown guard → Circuit breaker
Week 2 (P1): Entry trigger hardening → Pending zones → Score rebalance → Data freshness
Week 3 (P2): Session trim → Log noise → Memory cleanup → Timer optimization
```

## Expected Outcomes

- **Safety:** Eliminates guard bypass, orphaned plans, silent failures
- **Signal quality:** ~15-20% false positive reduction on entry triggers
- **Stability:** ~30-40% memory pressure reduction on 1GB server
- **Observability:** AI gets richer context (pending zones, data freshness, volatility warnings)
