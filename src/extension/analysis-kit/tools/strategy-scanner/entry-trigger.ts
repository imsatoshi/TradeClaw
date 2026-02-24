/**
 * 15m entry trigger — precise entry conditions with ATR-based SL/TP.
 *
 * Only called when setup score qualifies (≥ threshold).
 * Checks 3 trigger patterns per direction and computes 3-tier TP exits.
 */

import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import type { EntryTrigger, SignalDirection } from './types.js'
import { findSwingHighs, findSwingLows, rsiSeries, atrSeries } from './helpers.js'

/**
 * Check if 15m price action provides a valid entry trigger.
 *
 * @returns EntryTrigger if conditions met, null otherwise
 */
export function checkEntryTrigger(
  direction: SignalDirection,
  bars15m: MarketData[],
  atr: number,
): EntryTrigger | null {
  if (bars15m.length < 30 || atr <= 0) return null

  const closes = bars15m.map(b => b.close)
  const highs = bars15m.map(b => b.high)
  const lows = bars15m.map(b => b.low)
  const volumes = bars15m.map(b => b.volume)

  const current = bars15m[bars15m.length - 1]
  const prev = bars15m[bars15m.length - 2]
  const entry = current.close

  // Volume context for trigger confirmation
  const avgVol20 = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
  const currentVol = current.volume

  // RSI for swing detection
  const rsiArr = rsiSeries(closes, 14)
  if (rsiArr.length < 10) return null

  const offset = closes.length - rsiArr.length
  const len = rsiArr.length
  const aCloses = closes.slice(offset, offset + len)
  const aHighs = highs.slice(offset, offset + len)
  const aLows = lows.slice(offset, offset + len)
  const aVols = volumes.slice(offset, offset + len)

  let triggered = false
  let reason = ''

  if (direction === 'long') {
    // Trigger 1: Bullish confirmation — current close > previous high + volume above average
    if (current.close > prev.high && currentVol > avgVol20) {
      triggered = true
      reason = `bullish confirm: close $${current.close.toFixed(4)} > prev high $${prev.high.toFixed(4)}, vol ${(currentVol / avgVol20).toFixed(1)}x`
    }

    // Trigger 2: Support bounce — at swing low + bullish candle with meaningful lower wick
    if (!triggered) {
      const swingLows = findSwingLows(aLows, rsiArr, aVols, 3)
      if (swingLows.length > 0) {
        const nearest = swingLows[swingLows.length - 1]
        const distPct = ((entry - nearest.price) / nearest.price) * 100
        const body = Math.abs(current.close - current.open)
        const lowerWick = Math.min(current.close, current.open) - current.low
        const hasWick = body > 0 ? lowerWick >= body * 0.5 : lowerWick > 0
        if (distPct >= 0 && distPct <= 1.0 && current.close > current.open && hasWick) {
          triggered = true
          reason = `support bounce: at swing low $${nearest.price.toFixed(4)} (${distPct.toFixed(1)}%), wick rejection`
        }
      }
    }

    // Trigger 3: BOS pullback — broke swing high then pulled back near it
    if (!triggered) {
      const swingHighs = findSwingHighs(aHighs, rsiArr, aVols, 3)
      if (swingHighs.length > 0) {
        const recentHigh = swingHighs[swingHighs.length - 1]
        const age = len - 1 - recentHigh.index
        // Check if we're near the swing high level (within ±0.5%) and above it
        const distPct = ((entry - recentHigh.price) / recentHigh.price) * 100
        if (age <= 20 && distPct >= -0.5 && distPct <= 1.0 && current.close > current.open) {
          triggered = true
          reason = `BOS pullback: retesting swing high $${recentHigh.price.toFixed(2)} (${distPct.toFixed(1)}%, ${age} bars ago)`
        }
      }
    }

    if (!triggered) return null

    // SL: below recent structure or ATR-based
    let sl = entry - 1.5 * atr
    const swingLows = findSwingLows(aLows, rsiArr, aVols, 3)
    if (swingLows.length > 0) {
      const nearestLow = swingLows[swingLows.length - 1].price
      sl = Math.max(sl, nearestLow - 0.1 * atr)
    }

    // 3-tier TP
    const tp1 = entry + 1.5 * atr
    const tp2 = entry + 3.0 * atr
    const tp3 = entry + 4.5 * atr // estimated trailing target

    const slDist = entry - sl
    if (slDist <= 0) return null

    const weightedTP = tp1 * 0.4 + tp2 * 0.3 + tp3 * 0.3
    const rr = (weightedTP - entry) / slDist

    if (rr < 1.8) return null // minimum R:R requirement

    return {
      triggered: true,
      entry: round(entry),
      stopLoss: round(sl),
      takeProfits: {
        tp1: { price: round(tp1), ratio: 0.4 },
        tp2: { price: round(tp2), ratio: 0.3 },
        tp3: { price: round(tp3), ratio: 0.3 },
      },
      riskReward: round(rr),
      reason,
    }
  } else {
    // SHORT triggers (mirror logic)

    // Trigger 1: Bearish confirmation — current close < previous low + volume above average
    if (current.close < prev.low && currentVol > avgVol20) {
      triggered = true
      reason = `bearish confirm: close $${current.close.toFixed(4)} < prev low $${prev.low.toFixed(4)}, vol ${(currentVol / avgVol20).toFixed(1)}x`
    }

    // Trigger 2: Resistance rejection — at swing high + bearish candle with upper wick
    if (!triggered) {
      const swingHighs = findSwingHighs(aHighs, rsiArr, aVols, 3)
      if (swingHighs.length > 0) {
        const nearest = swingHighs[swingHighs.length - 1]
        const distPct = ((nearest.price - entry) / nearest.price) * 100
        const body = Math.abs(current.close - current.open)
        const upperWick = current.high - Math.max(current.close, current.open)
        const hasWick = body > 0 ? upperWick >= body * 0.5 : upperWick > 0
        if (distPct >= 0 && distPct <= 1.0 && current.close < current.open && hasWick) {
          triggered = true
          reason = `resistance reject: at swing high $${nearest.price.toFixed(4)} (${distPct.toFixed(1)}%), wick rejection`
        }
      }
    }

    // Trigger 3: BOS pullback — broke swing low then pulled back near it
    if (!triggered) {
      const swingLows = findSwingLows(aLows, rsiArr, aVols, 3)
      if (swingLows.length > 0) {
        const recentLow = swingLows[swingLows.length - 1]
        const age = len - 1 - recentLow.index
        const distPct = ((recentLow.price - entry) / recentLow.price) * 100
        if (age <= 20 && distPct >= -0.5 && distPct <= 1.0 && current.close < current.open) {
          triggered = true
          reason = `BOS pullback: retesting swing low $${recentLow.price.toFixed(2)} (${distPct.toFixed(1)}%, ${age} bars ago)`
        }
      }
    }

    if (!triggered) return null

    // SL: above recent structure or ATR-based
    let sl = entry + 1.5 * atr
    const swingHighs = findSwingHighs(aHighs, rsiArr, aVols, 3)
    if (swingHighs.length > 0) {
      const nearestHigh = swingHighs[swingHighs.length - 1].price
      sl = Math.min(sl, nearestHigh + 0.1 * atr)
    }

    // 3-tier TP
    const tp1 = entry - 1.5 * atr
    const tp2 = entry - 3.0 * atr
    const tp3 = entry - 4.5 * atr // estimated trailing target

    const slDist = sl - entry
    if (slDist <= 0) return null

    const weightedTP = tp1 * 0.4 + tp2 * 0.3 + tp3 * 0.3
    const rr = (entry - weightedTP) / slDist

    if (rr < 1.5) return null

    return {
      triggered: true,
      entry: round(entry),
      stopLoss: round(sl),
      takeProfits: {
        tp1: { price: round(tp1), ratio: 0.4 },
        tp2: { price: round(tp2), ratio: 0.3 },
        tp3: { price: round(tp3), ratio: 0.3 },
      },
      riskReward: round(rr),
      reason,
    }
  }
}

/** Adaptive precision: high-price coins get 2dp, low-price coins get up to 6dp. */
function round(v: number): number {
  const abs = Math.abs(v)
  if (abs >= 100) return Math.round(v * 100) / 100       // 2 dp ($95200.12)
  if (abs >= 1)   return Math.round(v * 10000) / 10000    // 4 dp ($0.1423)
  return Math.round(v * 1000000) / 1000000                // 6 dp ($0.000142)
}
