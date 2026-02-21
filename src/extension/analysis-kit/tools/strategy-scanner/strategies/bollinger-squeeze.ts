/**
 * Bollinger Band Squeeze + MACD Crossover strategy
 *
 * Breakout strategy (win rate ~55%):
 * - Bandwidth contracts below its 20-period average (squeeze)
 * - MACD histogram crosses zero (momentum shift)
 * - Volume confirms the breakout (> 1.5x average)
 */

import type { MarketData } from '../../../data/interfaces.js'
import type { StrategySignal } from '../types.js'
import { ATR } from '../../indicators/functions/technical.js'
import { bandwidthSeries, macdHistogramSeries, sma } from '../helpers.js'
import { getStrategyParams } from '../config.js'

export async function scanBollingerSqueeze(symbol: string, bars: MarketData[]): Promise<StrategySignal[]> {
  const config = await getStrategyParams()
  const p = config.bollinger_squeeze ?? {}

  const BB_PERIOD = p.bbPeriod ?? 20
  const BB_MULT = p.bbMultiplier ?? 2
  const MACD_FAST = p.macdFast ?? 12
  const MACD_SLOW = p.macdSlow ?? 26
  const MACD_SIGNAL = p.macdSignal ?? 9
  const ATR_PERIOD = p.atrPeriod ?? 14
  const VOL_AVG_PERIOD = p.volAvgPeriod ?? 20
  const VOL_CONFIRM_RATIO = p.volumeConfirmationRatio ?? 1.5
  const SL_MULT = p.slMultiplier ?? 1.5
  const TP_MULT = p.tpMultiplier ?? 2.5
  const STRONG_CONF = p.strongConfidence ?? 72
  const MOD_CONF = p.moderateConfidence ?? 55

  if (bars.length < MACD_SLOW + MACD_SIGNAL + BB_PERIOD) return []

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const volumes = bars.map(b => b.volume)

  // --- Bandwidth squeeze check ---
  const bw = bandwidthSeries(closes, BB_PERIOD, BB_MULT)
  if (bw.length < BB_PERIOD) return []

  const currentBW = bw[bw.length - 1]
  const avgBW = sma(bw, Math.min(BB_PERIOD, bw.length))
  const isSqueeze = currentBW < avgBW

  if (!isSqueeze) return []

  // --- MACD histogram zero-cross check ---
  const histogram = macdHistogramSeries(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL)
  if (histogram.length < 3) return []

  const h0 = histogram[histogram.length - 1]
  const h1 = histogram[histogram.length - 2]
  const h2 = histogram[histogram.length - 3]

  // Cross within last 2 bars: sign change between h2→h1 or h1→h0
  const crossUp = (h1 <= 0 && h0 > 0) || (h2 <= 0 && h1 > 0 && h0 > 0)
  const crossDown = (h1 >= 0 && h0 < 0) || (h2 >= 0 && h1 < 0 && h0 < 0)

  if (!crossUp && !crossDown) return []

  // --- Volume confirmation ---
  const avgVolume = sma(volumes, Math.min(VOL_AVG_PERIOD, volumes.length))
  const currentVolume = volumes[volumes.length - 1]
  const volumeConfirm = currentVolume > avgVolume * VOL_CONFIRM_RATIO

  const currentClose = closes[closes.length - 1]
  const atr = ATR(highs, lows, closes, ATR_PERIOD)
  const direction = crossUp ? 'long' as const : 'short' as const

  const sl = direction === 'long'
    ? currentClose - SL_MULT * atr
    : currentClose + SL_MULT * atr
  const tp = direction === 'long'
    ? currentClose + TP_MULT * atr
    : currentClose - TP_MULT * atr
  const rr = direction === 'long'
    ? (tp - currentClose) / (currentClose - sl)
    : (currentClose - tp) / (sl - currentClose)

  const strength = volumeConfirm ? 'strong' : 'moderate'
  const confidence = volumeConfirm ? STRONG_CONF : MOD_CONF

  return [{
    strategy: 'bollinger_squeeze',
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
      bandwidth: Math.round(currentBW * 10000) / 10000,
      avgBandwidth: Math.round(avgBW * 10000) / 10000,
      squeezeRatio: Math.round((currentBW / avgBW) * 100) / 100,
      macdHist: Math.round(h0 * 100) / 100,
      prevMacdHist: Math.round(h1 * 100) / 100,
      volumeRatio: Math.round((currentVolume / avgVolume) * 100) / 100,
      atr: Math.round(atr * 100) / 100,
    },
    reason: `Bollinger Squeeze breakout ${direction}: bandwidth ${(currentBW * 100).toFixed(2)}% < avg ${(avgBW * 100).toFixed(2)}%, MACD histogram crossed ${crossUp ? 'above' : 'below'} zero${volumeConfirm ? ` with ${(currentVolume / avgVolume).toFixed(1)}x avg volume` : ''}`,
  }]
}
