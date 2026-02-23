/**
 * RSI Divergence + Volume Exhaustion strategy (15m-native)
 *
 * Mean-reversion strategy:
 * - Bullish divergence: price makes lower low, RSI makes higher low
 * - Bearish divergence: price makes higher high, RSI makes lower high
 * - Swing recency filter ensures only fresh, actionable divergences fire
 * - Volume exhaustion used as a strength/confidence upgrade
 *
 * 15m parameters tuned per industry best practices:
 *   - Tighter OB/OS thresholds (75/25 vs 65/35) to filter 15m noise
 *   - Wider swing window (3 vs 2) for more reliable pivots
 *   - Max swing age, min/max spacing to avoid stale or noisy divergences
 */

import type { MarketData } from '../../../../archive-analysis/data/interfaces.js'
import type { StrategySignal } from '../types.js'
import { rsiSeries, findSwingLows, findSwingHighs, atrSeries } from '../helpers.js'
import { getStrategyParamsFor } from '../config.js'

export async function scanRsiDivergence(
  symbol: string,
  bars4h: MarketData[],
  bars15m?: MarketData[],
): Promise<StrategySignal[]> {
  // 15m-native: require 15m data
  if (!bars15m || bars15m.length < 50) return []

  const p = await getStrategyParamsFor('rsi_divergence', symbol)

  const RSI_PERIOD = p.rsiPeriod ?? 14
  const ATR_PERIOD = p.atrPeriod ?? 14
  const SWING_WINDOW = p.swingWindow ?? 3
  const OVERSOLD = p.oversoldThreshold ?? 25
  const OVERBOUGHT = p.overboughtThreshold ?? 75
  const VOL_EXHAUSTION_RATIO = p.volumeExhaustionRatio ?? 0.7
  const SL_MULT = p.slMultiplier ?? 1.5
  const TP_MULT = p.tpMultiplier ?? 2.5
  const STRONG_CONF = p.strongConfidence ?? 78
  const MOD_CONF = p.moderateConfidence ?? 62

  // Swing recency parameters (15m-tuned)
  const MAX_SWING_AGE = p.maxSwingAge ?? 20          // latest swing within 20 bars (5h)
  const MIN_SWING_SPACING = p.minSwingSpacing ?? 5   // min 5 bars between swings (1.25h)
  const MAX_SWING_SPACING = p.maxSwingSpacing ?? 40  // max 40 bars between swings (10h)

  if (bars15m.length < RSI_PERIOD + SWING_WINDOW * 2 + 10) return []

  const closes = bars15m.map(b => b.close)
  const volumes = bars15m.map(b => b.volume)
  const highs = bars15m.map(b => b.high)
  const lows = bars15m.map(b => b.low)

  const rsi = rsiSeries(closes, RSI_PERIOD)
  if (rsi.length < SWING_WINDOW * 2 + 5) return []

  // Align arrays: RSI starts at bar index RSI_PERIOD
  const offset = RSI_PERIOD
  const alignedCloses = closes.slice(offset)
  const alignedVolumes = volumes.slice(offset)

  // Trim all to the shortest length
  const len = Math.min(rsi.length, alignedCloses.length, alignedVolumes.length)
  const rc = alignedCloses.slice(0, len)
  const rv = rsi.slice(0, len)
  const av = alignedVolumes.slice(0, len)

  // ATR from 15m for SL/TP
  const atrArr = atrSeries(highs, lows, closes, ATR_PERIOD)
  const atr = atrArr[atrArr.length - 1]
  if (!atr || atr <= 0) return []

  const currentClose = closes[closes.length - 1]

  const signals: StrategySignal[] = []

  // --- Bullish divergence ---
  const swingLows = findSwingLows(rc, rv, av, SWING_WINDOW)
  if (swingLows.length >= 2) {
    const prev = swingLows[swingLows.length - 2]
    const latest = swingLows[swingLows.length - 1]

    // Swing recency + spacing filters
    const latestAge = len - 1 - latest.index
    const spacing = latest.index - prev.index

    if (latestAge <= MAX_SWING_AGE && spacing >= MIN_SWING_SPACING && spacing <= MAX_SWING_SPACING) {
      // Price lower low + RSI higher low = bullish divergence
      const priceLowerLow = latest.price <= prev.price
      const rsiHigherLow = latest.rsi > prev.rsi
      const oversold = latest.rsi < OVERSOLD
      const volumeExhaustion = latest.volume < prev.volume * VOL_EXHAUSTION_RATIO

      if (priceLowerLow && rsiHigherLow && oversold) {
        const sl = currentClose - SL_MULT * atr
        const tp = currentClose + TP_MULT * atr
        const rr = (tp - currentClose) / (currentClose - sl)

        const strength = volumeExhaustion ? 'strong' : 'moderate'
        const confidence = volumeExhaustion ? STRONG_CONF : MOD_CONF

        signals.push({
          strategy: 'rsi_divergence',
          symbol,
          direction: 'long',
          strength,
          confidence,
          timeframe: '15m',
          entry: currentClose,
          stopLoss: round(sl),
          takeProfit: round(tp),
          riskRewardRatio: round(rr),
          details: {
            prevSwingPrice: round(prev.price),
            latestSwingPrice: round(latest.price),
            prevSwingRSI: round(prev.rsi),
            latestSwingRSI: round(latest.rsi),
            volumeRatio: round(latest.volume / prev.volume),
            latestSwingAge: latestAge,
            swingSpacing: spacing,
            atr: round(atr),
          },
          reason: `Bullish RSI divergence (15m): price lower low ($${latest.price.toFixed(2)} vs $${prev.price.toFixed(2)}) but RSI higher low (${latest.rsi.toFixed(1)} vs ${prev.rsi.toFixed(1)}), swing age ${latestAge} bars${volumeExhaustion ? ', volume exhaustion' : ''}`,
        })
      }
    }
  }

  // --- Bearish divergence ---
  const swingHighs = findSwingHighs(rc, rv, av, SWING_WINDOW)
  if (swingHighs.length >= 2) {
    const prev = swingHighs[swingHighs.length - 2]
    const latest = swingHighs[swingHighs.length - 1]

    // Swing recency + spacing filters
    const latestAge = len - 1 - latest.index
    const spacing = latest.index - prev.index

    if (latestAge <= MAX_SWING_AGE && spacing >= MIN_SWING_SPACING && spacing <= MAX_SWING_SPACING) {
      // Price higher high + RSI lower high = bearish divergence
      const priceHigherHigh = latest.price >= prev.price
      const rsiLowerHigh = latest.rsi < prev.rsi
      const overbought = latest.rsi > OVERBOUGHT
      const volumeExhaustion = latest.volume < prev.volume * VOL_EXHAUSTION_RATIO

      if (priceHigherHigh && rsiLowerHigh && overbought) {
        const sl = currentClose + SL_MULT * atr
        const tp = currentClose - TP_MULT * atr
        const rr = (currentClose - tp) / (sl - currentClose)

        const strength = volumeExhaustion ? 'strong' : 'moderate'
        const confidence = volumeExhaustion ? STRONG_CONF : MOD_CONF

        signals.push({
          strategy: 'rsi_divergence',
          symbol,
          direction: 'short',
          strength,
          confidence,
          timeframe: '15m',
          entry: currentClose,
          stopLoss: round(sl),
          takeProfit: round(tp),
          riskRewardRatio: round(rr),
          details: {
            prevSwingPrice: round(prev.price),
            latestSwingPrice: round(latest.price),
            prevSwingRSI: round(prev.rsi),
            latestSwingRSI: round(latest.rsi),
            volumeRatio: round(latest.volume / prev.volume),
            latestSwingAge: latestAge,
            swingSpacing: spacing,
            atr: round(atr),
          },
          reason: `Bearish RSI divergence (15m): price higher high ($${latest.price.toFixed(2)} vs $${prev.price.toFixed(2)}) but RSI lower high (${latest.rsi.toFixed(1)} vs ${prev.rsi.toFixed(1)}), swing age ${latestAge} bars${volumeExhaustion ? ', volume exhaustion' : ''}`,
        })
      }
    }
  }

  return signals
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}
