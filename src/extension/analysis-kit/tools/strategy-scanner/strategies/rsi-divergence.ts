/**
 * RSI Divergence + Volume Exhaustion strategy
 *
 * Mean-reversion strategy (win rate ~60-65%):
 * - Bullish divergence: price makes lower low, RSI makes higher low, volume declining
 * - Bearish divergence: price makes higher high, RSI makes lower high, volume declining
 */

import type { MarketData } from '../../../data/interfaces.js'
import type { StrategySignal } from '../types.js'
import { ATR } from '../../indicators/functions/technical.js'
import { rsiSeries, findSwingLows, findSwingHighs } from '../helpers.js'

const RSI_PERIOD = 14
const ATR_PERIOD = 14
const SWING_WINDOW = 2

export function scanRsiDivergence(symbol: string, bars: MarketData[]): StrategySignal[] {
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

  const atr = ATR(highs, lows, closes, ATR_PERIOD)
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
    const oversold = latest.rsi < 35
    const volumeExhaustion = latest.volume < prev.volume * 0.5

    if (priceLowerLow && rsiHigherLow && oversold) {
      const sl = currentClose - 1.5 * atr
      const tp = currentClose + 2.5 * atr
      const rr = (tp - currentClose) / (currentClose - sl)

      const strength = volumeExhaustion ? 'strong' : 'moderate'
      const confidence = volumeExhaustion ? 78 : 62

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
    const overbought = latest.rsi > 65
    const volumeExhaustion = latest.volume < prev.volume * 0.5

    if (priceHigherHigh && rsiLowerHigh && overbought) {
      const sl = currentClose + 1.5 * atr
      const tp = currentClose - 2.5 * atr
      const rr = (currentClose - tp) / (sl - currentClose)

      const strength = volumeExhaustion ? 'strong' : 'moderate'
      const confidence = volumeExhaustion ? 78 : 62

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
        },
        reason: `Bearish RSI divergence: price higher high (${latest.price.toFixed(2)} vs ${prev.price.toFixed(2)}) but RSI lower high (${latest.rsi.toFixed(1)} vs ${prev.rsi.toFixed(1)})${volumeExhaustion ? ' with volume exhaustion' : ''}`,
      })
    }
  }

  return signals
}
