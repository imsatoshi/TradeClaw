/**
 * RSI Divergence + Volume Exhaustion strategy
 *
 * Mean-reversion strategy (win rate ~60-65%):
 * - Bullish divergence: price makes lower low, RSI makes higher low, volume declining
 * - Bearish divergence: price makes higher high, RSI makes lower high, volume declining
 */

import type { MarketData } from '../../../data/interfaces.js'
import type { StrategySignal } from '../types.js'
import { rsiSeries, findSwingLows, findSwingHighs, atrSeries } from '../helpers.js'
import { getStrategyParams } from '../config.js'

export async function scanRsiDivergence(symbol: string, bars: MarketData[], bars15m?: MarketData[]): Promise<StrategySignal[]> {
  const config = await getStrategyParams()
  const p = config.rsi_divergence ?? {}

  const RSI_PERIOD = p.rsiPeriod ?? 14
  const ATR_PERIOD = p.atrPeriod ?? 14
  const SWING_WINDOW = p.swingWindow ?? 2
  const OVERSOLD = p.oversoldThreshold ?? 35
  const OVERBOUGHT = p.overboughtThreshold ?? 65
  const VOL_EXHAUSTION_RATIO = p.volumeExhaustionRatio ?? 0.5
  const SL_MULT = p.slMultiplier ?? 1.5
  const TP_MULT = p.tpMultiplier ?? 2.5
  const STRONG_CONF = p.strongConfidence ?? 78
  const MOD_CONF = p.moderateConfidence ?? 62

  if (bars.length < RSI_PERIOD + SWING_WINDOW * 2 + 10) return []

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const volumes = bars.map(b => b.volume)

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

  // SL/TP uses 15m ATR when available (tighter, more appropriate for 15m execution)
  const slTpBars = bars15m && bars15m.length >= ATR_PERIOD + 2 ? bars15m : bars
  const slTpHighs = slTpBars.map(b => b.high)
  const slTpLows = slTpBars.map(b => b.low)
  const slTpCloses = slTpBars.map(b => b.close)
  const atrArr = atrSeries(slTpHighs, slTpLows, slTpCloses, ATR_PERIOD)
  const atr = atrArr[atrArr.length - 1]
  if (!atr || atr <= 0) return []

  const currentClose = closes[closes.length - 1]

  const signals: StrategySignal[] = []

  // --- Bullish divergence ---
  const swingLows = findSwingLows(rc, rv, av, SWING_WINDOW)
  if (swingLows.length >= 2) {
    const prev = swingLows[swingLows.length - 2]
    const latest = swingLows[swingLows.length - 1]

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
        timeframe: '4h',
        entry: currentClose,
        stopLoss: sl,
        takeProfit: tp,
        riskRewardRatio: Math.round(rr * 100) / 100,
        details: {
          prevSwingPrice: prev.price,
          latestSwingPrice: latest.price,
          prevSwingRSI: Math.round(prev.rsi * 100) / 100,
          latestSwingRSI: Math.round(latest.rsi * 100) / 100,
          volumeRatio: Math.round((latest.volume / prev.volume) * 100) / 100,
          atr: Math.round(atr * 100) / 100,
          slTpTimeframe: bars15m && bars15m.length >= ATR_PERIOD + 2 ? '15m' : '4h',
        },
        reason: `Bullish RSI divergence: price lower low (${latest.price.toFixed(2)} vs ${prev.price.toFixed(2)}) but RSI higher low (${latest.rsi.toFixed(1)} vs ${prev.rsi.toFixed(1)})${volumeExhaustion ? ' with volume exhaustion' : ''}`,
      })
    }
  }

  // --- Bearish divergence ---
  const swingHighs = findSwingHighs(rc, rv, av, SWING_WINDOW)
  if (swingHighs.length >= 2) {
    const prev = swingHighs[swingHighs.length - 2]
    const latest = swingHighs[swingHighs.length - 1]

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
        timeframe: '4h',
        entry: currentClose,
        stopLoss: sl,
        takeProfit: tp,
        riskRewardRatio: Math.round(rr * 100) / 100,
        details: {
          prevSwingPrice: prev.price,
          latestSwingPrice: latest.price,
          prevSwingRSI: Math.round(prev.rsi * 100) / 100,
          latestSwingRSI: Math.round(latest.rsi * 100) / 100,
          volumeRatio: Math.round((latest.volume / prev.volume) * 100) / 100,
          atr: Math.round(atr * 100) / 100,
          slTpTimeframe: bars15m && bars15m.length >= ATR_PERIOD + 2 ? '15m' : '4h',
        },
        reason: `Bearish RSI divergence: price higher high (${latest.price.toFixed(2)} vs ${prev.price.toFixed(2)}) but RSI lower high (${latest.rsi.toFixed(1)} vs ${prev.rsi.toFixed(1)})${volumeExhaustion ? ' with volume exhaustion' : ''}`,
      })
    }
  }

  return signals
}
