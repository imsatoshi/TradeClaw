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
    })
  }

  return results
}

// ==================== Regime-Strategy Filter ====================

/**
 * Regime-strategy compatibility rules.
 *
 * Mean-reversion strategies work in ranges; trend-following in trends.
 * `allowed: false` = hard filter (signal dropped).
 * `confidenceAdjust` = bonus/penalty applied to surviving signals.
 */
const REGIME_STRATEGY_RULES: Record<
  MarketRegime['regime'],
  Record<string, { allowed: boolean; confidenceAdjust: number }>
> = {
  uptrend: {
    ema_trend:        { allowed: true,  confidenceAdjust: +5 },
    breakout_volume:  { allowed: true,  confidenceAdjust: +5 },
    structure_break:  { allowed: true,  confidenceAdjust: +10 },
    rsi_divergence:   { allowed: false, confidenceAdjust: -20 },
    funding_fade:     { allowed: false, confidenceAdjust: -15 },
    bb_mean_revert:   { allowed: false, confidenceAdjust: -20 },
  },
  downtrend: {
    ema_trend:        { allowed: true,  confidenceAdjust: +5 },
    breakout_volume:  { allowed: true,  confidenceAdjust: +5 },
    structure_break:  { allowed: true,  confidenceAdjust: +10 },
    rsi_divergence:   { allowed: false, confidenceAdjust: -20 },
    funding_fade:     { allowed: false, confidenceAdjust: -15 },
    bb_mean_revert:   { allowed: false, confidenceAdjust: -20 },
  },
  ranging: {
    rsi_divergence:   { allowed: true,  confidenceAdjust: +5 },
    funding_fade:     { allowed: true,  confidenceAdjust: +5 },
    bb_mean_revert:   { allowed: true,  confidenceAdjust: +10 },
    ema_trend:        { allowed: false, confidenceAdjust: -15 },
    breakout_volume:  { allowed: false, confidenceAdjust: -15 },
    structure_break:  { allowed: false, confidenceAdjust: -15 },
  },
}

/**
 * Filter signals by regime compatibility.
 *
 * 1. Drop signals whose strategy is incompatible with current regime.
 * 2. Drop signals whose direction conflicts with trend (long in downtrend, short in uptrend).
 * 3. Adjust confidence for surviving signals.
 *
 * Mutates `confidence` and `details.regime` on surviving signals.
 */
export function applyRegimeFilter(
  signals: StrategySignal[],
  regime: MarketRegime,
): StrategySignal[] {
  return signals.filter(signal => {
    const rules = REGIME_STRATEGY_RULES[regime.regime]
    const rule = rules[signal.strategy]
    if (!rule) return true // unknown strategy, pass through

    if (!rule.allowed) return false

    // Direction alignment: block counter-trend signals
    if (regime.regime === 'uptrend' && signal.direction === 'short') return false
    if (regime.regime === 'downtrend' && signal.direction === 'long') return false

    // Adjust confidence
    signal.confidence = Math.min(100, Math.max(0, signal.confidence + rule.confidenceAdjust))
    signal.details = { ...signal.details, regime: regime.regime }
    return true
  })
}
