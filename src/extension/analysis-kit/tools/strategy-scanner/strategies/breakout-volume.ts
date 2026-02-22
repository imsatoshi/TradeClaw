/**
 * N-Period Breakout + Volume Confirmation strategy
 *
 * Breakout strategy (medium signal frequency):
 * - Bullish: close > highest high of last N bars + volume > 1.5x average
 * - Bearish: close < lowest low of last N bars + volume > 1.5x average
 * - Breakout magnitude and volume used for strength/confidence grading
 */

import type { MarketData } from '../../../data/interfaces.js'
import type { StrategySignal } from '../types.js'
import { sma, atrSeries } from '../helpers.js'
import { getStrategyParamsFor } from '../config.js'

export async function scanBreakoutVolume(symbol: string, bars: MarketData[], bars15m?: MarketData[]): Promise<StrategySignal[]> {
  const p = await getStrategyParamsFor('breakout_volume', symbol)

  const LOOKBACK = p.lookback ?? 20
  const ATR_PERIOD = p.atrPeriod ?? 14
  const VOL_AVG_PERIOD = p.volAvgPeriod ?? 20
  const VOL_CONFIRM_RATIO = p.volConfirmRatio ?? 1.5
  const VOL_STRONG_RATIO = p.volStrongRatio ?? 2.0
  const BREAKOUT_BONUS_PER_HALF_PCT = p.breakoutBonusPerHalfPct ?? 3
  const BREAKOUT_MAX_BONUS = p.breakoutMaxBonus ?? 12
  const VOL_STRONG_BONUS = p.volStrongBonus ?? 10
  const SL_MULT = p.slMultiplier ?? 1.5
  const TP_MULT = p.tpMultiplier ?? 2.5
  const STRONG_CONF = p.strongConfidence ?? 72
  const MOD_CONF = p.moderateConfidence ?? 58

  if (bars.length < LOOKBACK + ATR_PERIOD + 1) return []

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const volumes = bars.map(b => b.volume)

  const currentClose = closes[closes.length - 1]

  // N-period high/low (excluding current bar)
  const lookbackHighs = highs.slice(-(LOOKBACK + 1), -1)
  const lookbackLows = lows.slice(-(LOOKBACK + 1), -1)
  const periodHigh = Math.max(...lookbackHighs)
  const periodLow = Math.min(...lookbackLows)

  // Volume confirmation
  const avgVolume = sma(volumes, Math.min(VOL_AVG_PERIOD, volumes.length))
  const currentVolume = volumes[volumes.length - 1]
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1
  const volumeConfirm = volumeRatio > VOL_CONFIRM_RATIO

  // Check for breakout
  const bullishBreakout = currentClose > periodHigh && volumeConfirm
  const bearishBreakout = currentClose < periodLow && volumeConfirm

  if (!bullishBreakout && !bearishBreakout) return []

  // SL/TP uses 15m ATR when available (tighter, more appropriate for 15m execution)
  const slTpBars = bars15m && bars15m.length >= ATR_PERIOD + 2 ? bars15m : bars
  const slTpHighs = slTpBars.map(b => b.high)
  const slTpLows = slTpBars.map(b => b.low)
  const slTpCloses = slTpBars.map(b => b.close)
  const atrArr = atrSeries(slTpHighs, slTpLows, slTpCloses, ATR_PERIOD)
  const atr = atrArr[atrArr.length - 1]
  if (!atr || atr <= 0) return []

  const direction: 'long' | 'short' = bullishBreakout ? 'long' : 'short'

  // Breakout magnitude as percentage
  const breakoutMagnitude = direction === 'long'
    ? ((currentClose - periodHigh) / periodHigh) * 100
    : ((periodLow - currentClose) / periodLow) * 100

  // Strength: breakout > 1.5% + volume > 2x
  const strongBreakout = breakoutMagnitude > 1.5 && volumeRatio > VOL_STRONG_RATIO
  const strength = strongBreakout ? 'strong' : 'moderate'

  // Confidence calculation
  let confidence = strength === 'strong' ? STRONG_CONF : MOD_CONF

  // Breakout magnitude bonus: every 0.5% above 0 adds BREAKOUT_BONUS_PER_HALF_PCT, capped
  const breakoutBonus = Math.min(
    BREAKOUT_MAX_BONUS,
    Math.floor(breakoutMagnitude / 0.5) * BREAKOUT_BONUS_PER_HALF_PCT,
  )
  confidence += breakoutBonus

  // Strong volume bonus
  if (volumeRatio > VOL_STRONG_RATIO) {
    confidence += VOL_STRONG_BONUS
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
    strategy: 'breakout_volume',
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
      lookback: LOOKBACK,
      periodHigh: Math.round(periodHigh * 100) / 100,
      periodLow: Math.round(periodLow * 100) / 100,
      breakoutPct: Math.round(breakoutMagnitude * 100) / 100,
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      atr: Math.round(atr * 100) / 100,
      slTpTimeframe: bars15m && bars15m.length >= ATR_PERIOD + 2 ? '15m' : '4h',
    },
    reason: `${LOOKBACK}-bar breakout ${direction.toUpperCase()}: close ${currentClose.toFixed(2)} ${direction === 'long' ? '>' : '<'} ${direction === 'long' ? 'high' : 'low'} ${(direction === 'long' ? periodHigh : periodLow).toFixed(2)} (${breakoutMagnitude.toFixed(2)}%), vol ${volumeRatio.toFixed(1)}x avg`,
  }]
}
