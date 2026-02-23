/**
 * Structure Break (BOS) strategy (15m-native)
 *
 * Trend-following strategy that detects Break of Structure:
 * - Bullish BOS: price breaks above most recent swing high with volume
 * - Bearish BOS: price breaks below most recent swing low with volume
 * - Best suited for trending regimes (regime filter handles this)
 */

import type { MarketData } from '../../../../archive-analysis/data/interfaces.js'
import type { StrategySignal } from '../types.js'
import { rsiSeries, atrSeries, sma, findSwingHighs, findSwingLows } from '../helpers.js'
import { getStrategyParamsFor } from '../config.js'

export async function scanStructureBreak(
  symbol: string,
  bars4h: MarketData[],
  bars15m?: MarketData[],
): Promise<StrategySignal[]> {
  if (!bars15m || bars15m.length < 50) return []

  const p = await getStrategyParamsFor('structure_break', symbol)

  const SWING_WINDOW = p.swingWindow ?? 5
  const RSI_PERIOD = p.rsiPeriod ?? 14
  const ATR_PERIOD = p.atrPeriod ?? 14
  const VOL_AVG_PERIOD = p.volAvgPeriod ?? 20
  const VOL_CONFIRM = p.volConfirmRatio ?? 1.3
  const VOL_STRONG = p.volStrongRatio ?? 1.5
  const BREAK_PCT = p.breakPct ?? 0.3
  const SL_MULT = p.slMultiplier ?? 1.5
  const TP_MULT = p.tpMultiplier ?? 2.5
  const STRONG_CONF = p.strongConfidence ?? 72
  const MOD_CONF = p.moderateConfidence ?? 58

  // Swing recency parameters (15m-tuned)
  const MAX_SWING_AGE = p.maxSwingAge ?? 50         // max 50 bars (12.5h) — older swings are stale
  const VOL_AGING_THRESHOLD = p.volAgingThreshold ?? 30  // swings older than 30 bars need extra volume
  const VOL_AGING_RATIO = p.volAgingRatio ?? 1.6    // volume required for aging swings
  const FRESH_AGE = p.freshAge ?? 15                // swings <= 15 bars get a confidence bonus

  const closes = bars15m.map(b => b.close)
  const highs = bars15m.map(b => b.high)
  const lows = bars15m.map(b => b.low)
  const volumes = bars15m.map(b => b.volume)

  // RSI series for swing detection (helpers require aligned rsi+vol arrays)
  const rsiArr = rsiSeries(closes, RSI_PERIOD)
  if (rsiArr.length < SWING_WINDOW * 2 + 1) return []

  // Align arrays: rsiSeries returns length (closes.length - RSI_PERIOD)
  // So offset = RSI_PERIOD for highs/lows/volumes to align with rsi
  const offset = RSI_PERIOD
  const alignedHighs = highs.slice(offset)
  const alignedLows = lows.slice(offset)
  const alignedCloses = closes.slice(offset)
  const alignedVols = volumes.slice(offset)
  const len = Math.min(alignedHighs.length, rsiArr.length, alignedVols.length)

  const hSlice = alignedHighs.slice(0, len)
  const lSlice = alignedLows.slice(0, len)
  const rSlice = rsiArr.slice(0, len)
  const vSlice = alignedVols.slice(0, len)

  // Find swing points using highs for swing highs, lows for swing lows
  const swingHighs = findSwingHighs(hSlice, rSlice, vSlice, SWING_WINDOW)
  const swingLows = findSwingLows(lSlice, rSlice, vSlice, SWING_WINDOW)

  // Current bar values
  const currentClose = closes[closes.length - 1]
  const currentRsi = rsiArr[rsiArr.length - 1]
  const avgVol = sma(volumes, Math.min(VOL_AVG_PERIOD, volumes.length))
  const currentVol = volumes[volumes.length - 1]
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1
  const volumeConfirm = volRatio > VOL_CONFIRM

  // ATR from 15m for SL/TP
  const atrArr = atrSeries(highs, lows, closes, ATR_PERIOD)
  const atr = atrArr[atrArr.length - 1]
  if (!atr || atr <= 0) return []

  const signals: StrategySignal[] = []

  // Bullish BOS: price breaks above most recent swing high
  if (swingHighs.length >= 1 && volumeConfirm) {
    const recentHigh = swingHighs[swingHighs.length - 1]
    const swingAge = len - 1 - recentHigh.index

    // Swing recency: must be within [SWING_WINDOW, MAX_SWING_AGE]
    if (swingAge >= SWING_WINDOW && swingAge <= MAX_SWING_AGE && currentClose > recentHigh.price) {
      // Aging swings require stronger volume confirmation
      if (swingAge > VOL_AGING_THRESHOLD && volRatio < VOL_AGING_RATIO) {
        // Skip: stale swing with weak volume — likely false breakout
      } else {
        const breakPct = ((currentClose - recentHigh.price) / recentHigh.price) * 100
        const isStrong = breakPct > BREAK_PCT && volRatio > VOL_STRONG
        const strength = isStrong ? 'strong' as const : 'moderate' as const
        let confidence = isStrong ? STRONG_CONF : MOD_CONF
        if (volRatio > VOL_STRONG) confidence += 5

        // Age-based confidence adjustments
        if (swingAge <= FRESH_AGE) confidence += 3       // fresh swing bonus
        else if (swingAge > VOL_AGING_THRESHOLD) confidence -= 5  // aging swing penalty

        confidence = Math.min(100, Math.max(0, confidence))

        const sl = recentHigh.price - SL_MULT * atr // below broken structure
        const tp = currentClose + TP_MULT * atr
        const slDist = currentClose - sl
        const rr = slDist > 0 ? (tp - currentClose) / slDist : 0

        signals.push({
          strategy: 'structure_break',
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
            swingHighPrice: round(recentHigh.price),
            swingAge,
            breakPct: round(breakPct),
            rsi: round(currentRsi),
            volumeRatio: round(volRatio),
            atr: round(atr),
          },
          reason: `BOS LONG: price $${currentClose.toFixed(2)} broke swing high $${recentHigh.price.toFixed(2)} (+${breakPct.toFixed(1)}%), vol ${volRatio.toFixed(1)}x avg, age ${swingAge} bars, RSI ${currentRsi.toFixed(0)}`,
        })
      }
    }
  }

  // Bearish BOS: price breaks below most recent swing low
  if (swingLows.length >= 1 && volumeConfirm) {
    const recentLow = swingLows[swingLows.length - 1]
    const swingAge = len - 1 - recentLow.index

    // Swing recency: must be within [SWING_WINDOW, MAX_SWING_AGE]
    if (swingAge >= SWING_WINDOW && swingAge <= MAX_SWING_AGE && currentClose < recentLow.price) {
      // Aging swings require stronger volume confirmation
      if (swingAge > VOL_AGING_THRESHOLD && volRatio < VOL_AGING_RATIO) {
        // Skip: stale swing with weak volume — likely false breakout
      } else {
        const breakPct = ((recentLow.price - currentClose) / recentLow.price) * 100
        const isStrong = breakPct > BREAK_PCT && volRatio > VOL_STRONG
        const strength = isStrong ? 'strong' as const : 'moderate' as const
        let confidence = isStrong ? STRONG_CONF : MOD_CONF
        if (volRatio > VOL_STRONG) confidence += 5

        // Age-based confidence adjustments
        if (swingAge <= FRESH_AGE) confidence += 3       // fresh swing bonus
        else if (swingAge > VOL_AGING_THRESHOLD) confidence -= 5  // aging swing penalty

        confidence = Math.min(100, Math.max(0, confidence))

        const sl = recentLow.price + SL_MULT * atr // above broken structure
        const tp = currentClose - TP_MULT * atr
        const slDist = sl - currentClose
        const rr = slDist > 0 ? (currentClose - tp) / slDist : 0

        signals.push({
          strategy: 'structure_break',
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
            swingLowPrice: round(recentLow.price),
            swingAge,
            breakPct: round(breakPct),
            rsi: round(currentRsi),
            volumeRatio: round(volRatio),
            atr: round(atr),
          },
          reason: `BOS SHORT: price $${currentClose.toFixed(2)} broke swing low $${recentLow.price.toFixed(2)} (-${breakPct.toFixed(1)}%), vol ${volRatio.toFixed(1)}x avg, age ${swingAge} bars, RSI ${currentRsi.toFixed(0)}`,
        })
      }
    }
  }

  return signals
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}
