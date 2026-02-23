/**
 * Bollinger Band Mean Reversion strategy (5m)
 *
 * Mean-reversion strategy for ranging markets:
 * - Long: price touches lower BB + RSI oversold + volume exhaustion
 * - Short: price touches upper BB + RSI overbought + volume exhaustion
 * - Best suited for ranging regimes (regime filter handles this)
 */

import type { MarketData } from '../../../../archive-analysis/data/interfaces.js'
import type { StrategySignal } from '../types.js'
import { rsiSeries, atrSeries, sma } from '../helpers.js'
import { getStrategyParamsFor } from '../config.js'

export async function scanBBMeanRevert(
  symbol: string,
  bars: MarketData[],
): Promise<StrategySignal[]> {
  if (bars.length < 40) return []

  const p = await getStrategyParamsFor('bb_mean_revert', symbol)

  const BB_PERIOD = p.bbPeriod ?? 20
  const BB_MULT = p.bbMultiplier ?? 2
  const RSI_PERIOD = p.rsiPeriod ?? 14
  const ATR_PERIOD = p.atrPeriod ?? 14
  const VOL_AVG_PERIOD = p.volAvgPeriod ?? 20
  const RSI_OB = p.overboughtThreshold ?? 70
  const RSI_OS = p.oversoldThreshold ?? 30
  const VOL_EXHAUST = p.volumeExhaustionRatio ?? 0.7
  const SL_MULT = p.slMultiplier ?? 1.0
  const TP_MULT = p.tpMultiplier ?? 1.5
  const STRONG_CONF = p.strongConfidence ?? 75
  const MOD_CONF = p.moderateConfidence ?? 60
  const PIERCE_PCT = p.piercePct ?? 0.5

  if (bars.length < BB_PERIOD + RSI_PERIOD) return []

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const volumes = bars.map(b => b.volume)

  // Bollinger Bands on 15m
  const bbSlice = closes.slice(-BB_PERIOD)
  const middle = bbSlice.reduce((s, v) => s + v, 0) / BB_PERIOD
  const variance = bbSlice.reduce((s, v) => s + (v - middle) ** 2, 0) / BB_PERIOD
  const stdDev = Math.sqrt(variance)
  const upper = middle + BB_MULT * stdDev
  const lower = middle - BB_MULT * stdDev

  if (stdDev <= 0 || middle <= 0) return []

  // RSI on 15m (last value)
  const rsiArr = rsiSeries(closes, RSI_PERIOD)
  if (rsiArr.length === 0) return []
  const rsi = rsiArr[rsiArr.length - 1]

  // ATR from 15m for SL/TP
  const atrArr = atrSeries(highs, lows, closes, ATR_PERIOD)
  const atr = atrArr[atrArr.length - 1]
  if (!atr || atr <= 0) return []

  // Volume analysis
  const currentClose = closes[closes.length - 1]
  const avgVol = sma(volumes, Math.min(VOL_AVG_PERIOD, volumes.length))
  const currentVol = volumes[volumes.length - 1]
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1
  const exhaustion = volRatio < VOL_EXHAUST

  // Bandwidth as % of middle (for details)
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0

  const signals: StrategySignal[] = []

  // Long: price at/below lower band + RSI oversold
  if (currentClose <= lower && rsi < RSI_OS) {
    const piercePct = ((lower - currentClose) / lower) * 100
    const isStrong = piercePct > PIERCE_PCT && exhaustion
    const strength = isStrong ? 'strong' as const : 'moderate' as const
    let confidence = isStrong ? STRONG_CONF : MOD_CONF
    if (exhaustion) confidence += 5
    confidence = Math.min(100, confidence)

    const sl = currentClose - SL_MULT * atr
    const tp = currentClose + TP_MULT * atr // target middle band
    const rr = (tp - currentClose) / (currentClose - sl)

    signals.push({
      strategy: 'bb_mean_revert',
      symbol,
      direction: 'long',
      strength,
      confidence,
      timeframe: '5m',
      entry: currentClose,
      stopLoss: round(sl),
      takeProfit: round(tp),
      riskRewardRatio: round(rr),
      details: {
        bbUpper: round(upper),
        bbMiddle: round(middle),
        bbLower: round(lower),
        bandwidth: round(bandwidth),
        rsi: round(rsi),
        volumeRatio: round(volRatio),
        exhaustion: exhaustion ? 1 : 0,
        piercePct: round(piercePct),
        atr: round(atr),
      },
      reason: `BB mean revert LONG: price $${currentClose.toFixed(2)} at lower band $${lower.toFixed(2)} (pierce ${piercePct.toFixed(1)}%), RSI ${rsi.toFixed(0)}, vol ${volRatio.toFixed(1)}x avg${exhaustion ? ' (exhaustion)' : ''}`,
    })
  }

  // Short: price at/above upper band + RSI overbought
  if (currentClose >= upper && rsi > RSI_OB) {
    const piercePct = ((currentClose - upper) / upper) * 100
    const isStrong = piercePct > PIERCE_PCT && exhaustion
    const strength = isStrong ? 'strong' as const : 'moderate' as const
    let confidence = isStrong ? STRONG_CONF : MOD_CONF
    if (exhaustion) confidence += 5
    confidence = Math.min(100, confidence)

    const sl = currentClose + SL_MULT * atr
    const tp = currentClose - TP_MULT * atr // target middle band
    const rr = (currentClose - tp) / (sl - currentClose)

    signals.push({
      strategy: 'bb_mean_revert',
      symbol,
      direction: 'short',
      strength,
      confidence,
      timeframe: '5m',
      entry: currentClose,
      stopLoss: round(sl),
      takeProfit: round(tp),
      riskRewardRatio: round(rr),
      details: {
        bbUpper: round(upper),
        bbMiddle: round(middle),
        bbLower: round(lower),
        bandwidth: round(bandwidth),
        rsi: round(rsi),
        volumeRatio: round(volRatio),
        exhaustion: exhaustion ? 1 : 0,
        piercePct: round(piercePct),
        atr: round(atr),
      },
      reason: `BB mean revert SHORT: price $${currentClose.toFixed(2)} at upper band $${upper.toFixed(2)} (pierce ${piercePct.toFixed(1)}%), RSI ${rsi.toFixed(0)}, vol ${volRatio.toFixed(1)}x avg${exhaustion ? ' (exhaustion)' : ''}`,
    })
  }

  return signals
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}
