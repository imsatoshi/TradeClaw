/**
 * EMA Trend Momentum strategy
 *
 * Trend-following strategy (high signal frequency):
 * - Bullish: EMA9 > EMA21 > EMA55 (triple alignment) + RSI 40-70
 * - Bearish: EMA9 < EMA21 < EMA55 (triple alignment) + RSI 30-60
 * - Volume and EMA separation used for strength/confidence grading
 */

import type { MarketData } from '../../../data/interfaces.js'
import type { StrategySignal } from '../types.js'
import { RSI, ATR } from '../../indicators/functions/technical.js'
import { emaSeries, sma } from '../helpers.js'
import { getStrategyParams } from '../config.js'

export async function scanEmaTrend(symbol: string, bars: MarketData[]): Promise<StrategySignal[]> {
  const config = await getStrategyParams()
  const p = config.ema_trend ?? {}

  const EMA_FAST = p.emaFast ?? 9
  const EMA_MID = p.emaMid ?? 21
  const EMA_SLOW = p.emaSlow ?? 55
  const RSI_PERIOD = p.rsiPeriod ?? 14
  const ATR_PERIOD = p.atrPeriod ?? 14
  const VOL_AVG_PERIOD = p.volAvgPeriod ?? 20
  const RSI_LONG_MIN = p.rsiLongMin ?? 40
  const RSI_LONG_MAX = p.rsiLongMax ?? 70
  const RSI_SHORT_MIN = p.rsiShortMin ?? 30
  const RSI_SHORT_MAX = p.rsiShortMax ?? 60
  const VOL_STRONG_RATIO = p.volStrongRatio ?? 1.2
  const VOL_BONUS_RATIO = p.volBonusRatio ?? 1.5
  const VOL_BONUS = p.volBonus ?? 8
  const EMA_SEP_MAX_BONUS = p.emaSeparationMaxBonus ?? 15
  const SL_MULT = p.slMultiplier ?? 1.5
  const TP_MULT = p.tpMultiplier ?? 2.5
  const STRONG_CONF = p.strongConfidence ?? 72
  const MOD_CONF = p.moderateConfidence ?? 60

  // Need enough bars for the slowest EMA + RSI
  if (bars.length < EMA_SLOW + RSI_PERIOD) return []

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const volumes = bars.map(b => b.volume)

  // Compute EMA series
  const emaFastSeries = emaSeries(closes, EMA_FAST)
  const emaMidSeries = emaSeries(closes, EMA_MID)
  const emaSlowSeries = emaSeries(closes, EMA_SLOW)

  if (emaSlowSeries.length === 0) return []

  // Get latest EMA values (align to slowest series)
  const emaFastVal = emaFastSeries[emaFastSeries.length - 1 - (EMA_SLOW - EMA_FAST)]
  const emaMidVal = emaMidSeries[emaMidSeries.length - 1 - (EMA_SLOW - EMA_MID)]
  const emaSlowVal = emaSlowSeries[emaSlowSeries.length - 1]

  if (emaFastVal === undefined || emaMidVal === undefined || emaSlowVal === undefined) return []

  // Check triple EMA alignment
  const bullishAlignment = emaFastVal > emaMidVal && emaMidVal > emaSlowVal
  const bearishAlignment = emaFastVal < emaMidVal && emaMidVal < emaSlowVal

  if (!bullishAlignment && !bearishAlignment) return []

  const rsi = RSI(closes, RSI_PERIOD)
  const atr = ATR(highs, lows, closes, ATR_PERIOD)
  if (!atr || atr <= 0) return []

  const currentClose = closes[closes.length - 1]
  const avgVolume = sma(volumes, Math.min(VOL_AVG_PERIOD, volumes.length))
  const currentVolume = volumes[volumes.length - 1]
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1

  // Determine direction and validate RSI range
  let direction: 'long' | 'short'
  if (bullishAlignment && rsi >= RSI_LONG_MIN && rsi <= RSI_LONG_MAX) {
    direction = 'long'
  } else if (bearishAlignment && rsi >= RSI_SHORT_MIN && rsi <= RSI_SHORT_MAX) {
    direction = 'short'
  } else {
    return []
  }

  // Strength: price on correct side of EMA9 + volume confirmation
  const priceAboveFastEma = currentClose > emaFastVal
  const priceBelowFastEma = currentClose < emaFastVal
  const priceCorrectSide = direction === 'long' ? priceAboveFastEma : priceBelowFastEma
  const volumeStrong = volumeRatio > VOL_STRONG_RATIO

  const strength = priceCorrectSide && volumeStrong ? 'strong' : 'moderate'

  // Confidence calculation
  let confidence = strength === 'strong' ? STRONG_CONF : MOD_CONF

  // EMA separation bonus: (EMA_FAST - EMA_SLOW) / EMA_SLOW as percentage
  const emaSeparation = Math.abs(emaFastVal - emaSlowVal) / emaSlowVal * 100
  const emaBonus = Math.min(EMA_SEP_MAX_BONUS, Math.round(emaSeparation * 5))
  confidence += emaBonus

  // Volume bonus
  if (volumeRatio > VOL_BONUS_RATIO) {
    confidence += VOL_BONUS
  }

  confidence = Math.min(100, confidence)

  // Stop loss and take profit
  const sl = direction === 'long'
    ? currentClose - SL_MULT * atr
    : currentClose + SL_MULT * atr
  const tp = direction === 'long'
    ? currentClose + TP_MULT * atr
    : currentClose - TP_MULT * atr
  const rr = direction === 'long'
    ? (tp - currentClose) / (currentClose - sl)
    : (currentClose - tp) / (sl - currentClose)

  return [{
    strategy: 'ema_trend',
    symbol,
    direction,
    strength,
    confidence,
    timeframe: '4h',
    entry: currentClose,
    stopLoss: Math.round(sl * 100) / 100,
    takeProfit: Math.round(tp * 100) / 100,
    riskRewardRatio: Math.round(rr * 100) / 100,
    details: {
      emaFast: Math.round(emaFastVal * 100) / 100,
      emaMid: Math.round(emaMidVal * 100) / 100,
      emaSlow: Math.round(emaSlowVal * 100) / 100,
      emaSeparationPct: Math.round(emaSeparation * 100) / 100,
      rsi: Math.round(rsi * 100) / 100,
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      atr: Math.round(atr * 100) / 100,
    },
    reason: `EMA trend ${direction.toUpperCase()}: EMA${EMA_FAST}(${emaFastVal.toFixed(2)}) ${bullishAlignment ? '>' : '<'} EMA${EMA_MID}(${emaMidVal.toFixed(2)}) ${bullishAlignment ? '>' : '<'} EMA${EMA_SLOW}(${emaSlowVal.toFixed(2)}), RSI ${rsi.toFixed(1)}, vol ${volumeRatio.toFixed(1)}x avg`,
  }]
}
