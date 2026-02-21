/**
 * Market regime detection for NFI X7 protection.
 *
 * Uses 4H EMA9/21/55 alignment + price position to classify each symbol
 * as downtrend / uptrend / ranging. The heartbeat uses this to lock pairs
 * in a sustained downtrend before NFI's grinding system gets trapped.
 */

import type { MarketData } from '../../data/interfaces.js'
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
