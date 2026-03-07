/**
 * Market regime detection for AI trading context.
 *
 * Uses 4H EMA9/21/55 alignment + price position to classify each symbol
 * as downtrend / uptrend / ranging. The heartbeat uses this as context
 * for evaluating strategy signals and managing open positions.
 */

import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import type { StrategySignal } from './types.js'
import { emaSeries, rsiSeries } from './helpers.js'

export interface MarketRegime {
  symbol: string
  regime: 'downtrend' | 'uptrend' | 'ranging'
  emaFast: number    // EMA9
  emaMid: number     // EMA21
  emaSlow: number    // EMA55
  price: number      // current close
  priceVsEma55: number  // % deviation from EMA55
  rsi: number
  reason: string     // human-readable explanation
  /** How many consecutive 4H bars the current regime has held. */
  regimeDuration: number
  /** True if regime just changed (duration < 8 bars = 32 hours). Fresh regimes are less reliable. */
  isFreshRegime: boolean
}

/**
 * Detect market regime for each symbol using 4H OHLCV data.
 *
 * Logic:
 *   downtrend: EMA9 < EMA21 < EMA55 AND price < EMA55
 *   uptrend:   EMA9 > EMA21 > EMA55 AND price > EMA55
 *   ranging:   anything else
 *
 * @param symbols  - list of trading pairs
 * @param ohlcv4h  - pre-fetched 4H candle data keyed by symbol
 */
export function detectMarketRegime(
  symbols: string[],
  ohlcv4h: Record<string, MarketData[]>,
): MarketRegime[] {
  const results: MarketRegime[] = []

  for (const symbol of symbols) {
    const bars = ohlcv4h[symbol]
    if (!bars || bars.length < 55) {
      // Not enough data — default to ranging (safe, no lock)
      results.push({
        symbol,
        regime: 'ranging',
        emaFast: 0,
        emaMid: 0,
        emaSlow: 0,
        price: bars?.[bars.length - 1]?.close ?? 0,
        priceVsEma55: 0,
        rsi: 50,
        reason: 'insufficient data (< 55 bars)',
        regimeDuration: 0,
        isFreshRegime: true,
      })
      continue
    }

    const closes = bars.map((b) => b.close)
    const price = closes[closes.length - 1]

    // EMA series — take the last value
    const ema9 = emaSeries(closes, 9)
    const ema21 = emaSeries(closes, 21)
    const ema55 = emaSeries(closes, 55)

    const emaFast = ema9[ema9.length - 1]
    const emaMid = ema21[ema21.length - 1]
    const emaSlow = ema55[ema55.length - 1]

    // RSI14 — take the last value
    const rsiArr = rsiSeries(closes, 14)
    const rsi = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50

    // % deviation of price from EMA55
    const priceVsEma55 = emaSlow !== 0
      ? ((price - emaSlow) / emaSlow) * 100
      : 0

    // Classify regime
    let regime: MarketRegime['regime']
    let reason: string

    if (emaFast < emaMid && emaMid < emaSlow && price < emaSlow) {
      regime = 'downtrend'
      reason = `EMA9(${emaFast.toPrecision(4)}) < EMA21(${emaMid.toPrecision(4)}) < EMA55(${emaSlow.toPrecision(4)}), price $${price.toPrecision(4)} (${priceVsEma55.toFixed(1)}% vs EMA55), RSI ${rsi.toFixed(0)}`
    } else if (emaFast > emaMid && emaMid > emaSlow && price > emaSlow) {
      regime = 'uptrend'
      reason = `EMA9(${emaFast.toPrecision(4)}) > EMA21(${emaMid.toPrecision(4)}) > EMA55(${emaSlow.toPrecision(4)}), price $${price.toPrecision(4)} (+${priceVsEma55.toFixed(1)}% vs EMA55), RSI ${rsi.toFixed(0)}`
    } else {
      regime = 'ranging'
      reason = `EMA no clear alignment, price $${price.toPrecision(4)} (${priceVsEma55 >= 0 ? '+' : ''}${priceVsEma55.toFixed(1)}% vs EMA55), RSI ${rsi.toFixed(0)}`
    }

    // Count regime duration: how many consecutive bars had the same regime
    let regimeDuration = 1
    const ema9Arr = ema9
    const ema21Arr = ema21
    const ema55Arr = ema55
    for (let i = ema9Arr.length - 2; i >= 0 && i >= ema9Arr.length - 30; i--) {
      const f = ema9Arr[i], m = ema21Arr[i], s = ema55Arr[i]
      const p = closes[i + (closes.length - ema9Arr.length)]
      let pastRegime: MarketRegime['regime']
      if (f < m && m < s && p < s) pastRegime = 'downtrend'
      else if (f > m && m > s && p > s) pastRegime = 'uptrend'
      else pastRegime = 'ranging'
      if (pastRegime === regime) regimeDuration++
      else break
    }
    const isFreshRegime = regimeDuration < 8
    if (isFreshRegime) {
      reason += ` [FRESH regime: ${regimeDuration} bars]`
    }

    results.push({
      symbol,
      regime,
      emaFast,
      emaMid,
      emaSlow,
      price,
      priceVsEma55,
      rsi,
      reason,
      regimeDuration,
      isFreshRegime,
    })
  }

  return results
}

// ==================== Regime-Strategy Filter ====================

/**
 * Regime-strategy compatibility rules (soft filter).
 *
 * All strategies are ALLOWED in all regimes — the direction filter (line 172-173)
 * is the safety net that blocks counter-trend signals (long in downtrend, short in uptrend).
 *
 * Strategy category determines a confidence ADJUSTMENT, not a hard block:
 *   - Regime-aligned strategies get a bonus (+10)
 *   - Regime-misaligned strategies get a penalty (-10)
 *   - The MIN_COMPOSITE_SCORE (60) in confluence.ts naturally filters low-quality signals
 *
 * This allows cross-category confluence (e.g., breakout_volume + funding_fade LONG in uptrend)
 * which was previously impossible due to hard blocking of mean-reversion in trends.
 */
const REGIME_STRATEGY_RULES: Record<
  MarketRegime['regime'],
  Record<string, { allowed: boolean; confidenceAdjust: number }>
> = {
  uptrend: {
    ema_trend:        { allowed: true, confidenceAdjust: +10 },
    breakout_volume:  { allowed: true, confidenceAdjust: +10 },
    structure_break:  { allowed: true, confidenceAdjust: +10 },
    rsi_divergence:   { allowed: true, confidenceAdjust: -10 },
    funding_fade:     { allowed: true, confidenceAdjust: -10 },
    bb_mean_revert:   { allowed: true, confidenceAdjust: -10 },
  },
  downtrend: {
    ema_trend:        { allowed: true, confidenceAdjust: +10 },
    breakout_volume:  { allowed: true, confidenceAdjust: +10 },
    structure_break:  { allowed: true, confidenceAdjust: +10 },
    rsi_divergence:   { allowed: true, confidenceAdjust: -10 },
    funding_fade:     { allowed: true, confidenceAdjust: -10 },
    bb_mean_revert:   { allowed: true, confidenceAdjust: -10 },
  },
  ranging: {
    rsi_divergence:   { allowed: true, confidenceAdjust: +10 },
    funding_fade:     { allowed: true, confidenceAdjust: +10 },
    bb_mean_revert:   { allowed: true, confidenceAdjust: +10 },
    ema_trend:        { allowed: true, confidenceAdjust: -10 },
    breakout_volume:  { allowed: true, confidenceAdjust: -10 },
    structure_break:  { allowed: true, confidenceAdjust: -10 },
  },
}

/**
 * Filter signals by regime compatibility.
 *
 * 1. Hard filter: block counter-trend DIRECTION (long in downtrend, short in uptrend).
 *    This is the safety net — never fight the trend direction.
 * 2. Soft filter: adjust confidence by strategy-regime alignment.
 *    Regime-aligned strategies get a bonus, misaligned get a penalty.
 *    No strategy is ever hard-blocked — confidence + MIN_COMPOSITE_SCORE handle quality.
 *
 * Mutates `confidence` and `details.regime` on surviving signals.
 */
export function applyRegimeFilter(
  signals: StrategySignal[],
  regime: MarketRegime,
): StrategySignal[] {
  return signals.filter(signal => {
    // Hard filter: block counter-trend direction (the primary safety net)
    if (regime.regime === 'uptrend' && signal.direction === 'short') return false
    if (regime.regime === 'downtrend' && signal.direction === 'long') return false

    // Soft filter: adjust confidence by strategy-regime alignment
    const rules = REGIME_STRATEGY_RULES[regime.regime]
    const rule = rules[signal.strategy]
    if (rule) {
      signal.confidence = Math.min(100, Math.max(0, signal.confidence + rule.confidenceAdjust))
    }
    signal.details = { ...signal.details, regime: regime.regime }
    return true
  })
}
