/**
 * Series-based indicator calculations for strategy scanning.
 *
 * The existing technical.ts functions return a single final value.
 * Divergence/squeeze detection requires full series, so we implement
 * dedicated series versions here without modifying technical.ts.
 */

import type { SwingPoint } from './types.js'

/**
 * Compute RSI for every bar using Wilder smoothing.
 * Returns array of length (closes.length - period).
 * Index 0 corresponds to bar at closes[period].
 */
export function rsiSeries(closes: number[], period: number = 14): number[] {
  if (closes.length < period + 1) return []

  const result: number[] = []
  const changes: number[] = []
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1])
  }

  const gains = changes.map(c => (c > 0 ? c : 0))
  const losses = changes.map(c => (c < 0 ? -c : 0))

  // Seed with SMA of first `period` changes
  let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period
  let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period

  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  result.push(rsi)

  // Wilder smoothing for remaining bars
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  }

  return result
}

/**
 * Find local minima (swing lows) within a symmetric window.
 * Prices, rsiValues, and volumes must be aligned arrays.
 */
export function findSwingLows(
  prices: number[],
  rsiValues: number[],
  volumes: number[],
  window: number = 2,
): SwingPoint[] {
  const points: SwingPoint[] = []
  for (let i = window; i < prices.length - window; i++) {
    let isLow = true
    for (let j = 1; j <= window; j++) {
      if (prices[i] > prices[i - j] || prices[i] > prices[i + j]) {
        isLow = false
        break
      }
    }
    if (isLow) {
      points.push({ index: i, price: prices[i], rsi: rsiValues[i], volume: volumes[i] })
    }
  }
  return points
}

/**
 * Find local maxima (swing highs) within a symmetric window.
 */
export function findSwingHighs(
  prices: number[],
  rsiValues: number[],
  volumes: number[],
  window: number = 2,
): SwingPoint[] {
  const points: SwingPoint[] = []
  for (let i = window; i < prices.length - window; i++) {
    let isHigh = true
    for (let j = 1; j <= window; j++) {
      if (prices[i] < prices[i - j] || prices[i] < prices[i + j]) {
        isHigh = false
        break
      }
    }
    if (isHigh) {
      points.push({ index: i, price: prices[i], rsi: rsiValues[i], volume: volumes[i] })
    }
  }
  return points
}

/**
 * Rolling Bollinger Bandwidth: (upper - lower) / middle for each bar.
 * Returns array of length (closes.length - period + 1).
 */
export function bandwidthSeries(
  closes: number[],
  period: number = 20,
  multiplier: number = 2,
): number[] {
  const result: number[] = []
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = slice.reduce((s, v) => s + v, 0) / period
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period
    const stdDev = Math.sqrt(variance)
    const upper = mean + stdDev * multiplier
    const lower = mean - stdDev * multiplier
    result.push(mean === 0 ? 0 : (upper - lower) / mean)
  }
  return result
}

/**
 * Rolling MACD histogram series.
 * Returns array starting from bar (slow + signal - 1).
 */
export function macdHistogramSeries(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9,
): number[] {
  if (closes.length < slow + signal) return []

  // Compute full EMA series
  const fastEma = emaSeries(closes, fast)
  const slowEma = emaSeries(closes, slow)

  // MACD line = fastEMA - slowEMA, aligned to slowEma start
  const offset = slow - fast
  const macdLine: number[] = []
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i])
  }

  // Signal line = EMA of MACD line
  const signalLine = emaSeries(macdLine, signal)

  // Histogram = MACD - signal, aligned to signal start
  const histOffset = signal - 1
  const histogram: number[] = []
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + histOffset] - signalLine[i])
  }

  return histogram
}

/**
 * Compute EMA for every bar, returning series of length (data.length - period + 1).
 */
export function emaSeries(data: number[], period: number): number[] {
  if (data.length < period) return []

  const result: number[] = []
  const multiplier = 2 / (period + 1)
  let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period
  result.push(ema)

  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema
    result.push(ema)
  }

  return result
}

/**
 * Average True Range series.
 * Returns array of ATR values computed as EMA of True Range.
 * Length = emaSeries(TR, period).length where TR has length (highs.length - 1).
 */
export function atrSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number[] {
  if (highs.length < 2) return []
  const tr: number[] = []
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ))
  }
  return emaSeries(tr, period)
}

/**
 * Simple Moving Average over the last `period` values of an array.
 * Utility for inline use (avoids importing from statistics.ts).
 */
export function sma(data: number[], period: number): number {
  if (data.length < period) return data.length > 0 ? data.reduce((s, v) => s + v, 0) / data.length : 0
  const slice = data.slice(-period)
  return slice.reduce((s, v) => s + v, 0) / period
}

// ==================== V2 Pipeline Helpers ====================

/**
 * Rate of Change series: ROC[i] = (data[i] - data[i-period]) / data[i-period] * 100
 * Returns array of length (data.length - period).
 */
export function rocSeries(data: number[], period: number): number[] {
  if (data.length <= period) return []
  const result: number[] = []
  for (let i = period; i < data.length; i++) {
    const prev = data[i - period]
    result.push(prev !== 0 ? ((data[i] - prev) / prev) * 100 : 0)
  }
  return result
}

/** Detected Fair Value Gap. */
export interface FVG {
  index: number    // index of the middle candle (the impulse candle)
  gapHigh: number  // upper boundary of the gap
  gapLow: number   // lower boundary of the gap
}

/**
 * Detect Fair Value Gaps (3-candle imbalance patterns).
 *
 * Bullish FVG: candle[i-1].high < candle[i+1].low — gap up
 * Bearish FVG: candle[i-1].low > candle[i+1].high — gap down
 */
export function detectFVGs(
  highs: number[],
  lows: number[],
  direction: 'long' | 'short',
): FVG[] {
  const result: FVG[] = []
  for (let i = 1; i < highs.length - 1; i++) {
    if (direction === 'long') {
      // Bullish FVG: previous high < next low (gap up)
      if (highs[i - 1] < lows[i + 1]) {
        result.push({ index: i, gapHigh: lows[i + 1], gapLow: highs[i - 1] })
      }
    } else {
      // Bearish FVG: previous low > next high (gap down)
      if (lows[i - 1] > highs[i + 1]) {
        result.push({ index: i, gapHigh: lows[i - 1], gapLow: highs[i + 1] })
      }
    }
  }
  return result
}

/** BOS/CHoCH validation result. */
export interface BOSResult {
  bosConfirmed: boolean
  choch: boolean
  detail: string
}

/**
 * Validate Break of Structure using swing sequence progression.
 *
 * Bullish BOS: latest 2+ swing highs are Higher Highs AND 2+ swing lows are Higher Lows.
 * Bearish BOS: latest 2+ swing highs are Lower Highs AND 2+ swing lows are Lower Lows.
 * CHoCH (Change of Character): the previous sequence was broken
 *   (e.g., was making LH+LL, now latest swing high is HH → bullish CHoCH).
 */
export function validateBOSSequence(
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[],
  direction: 'long' | 'short',
): BOSResult {
  const noData: BOSResult = { bosConfirmed: false, choch: false, detail: 'insufficient swings' }
  if (swingHighs.length < 2 || swingLows.length < 2) return noData

  // Take last 3 swing points for sequence analysis
  const recentHighs = swingHighs.slice(-3)
  const recentLows = swingLows.slice(-3)

  // Check latest 2 swing highs and lows for progression
  const h = recentHighs
  const l = recentLows
  const lastH = h[h.length - 1]
  const prevH = h[h.length - 2]
  const lastL = l[l.length - 1]
  const prevL = l[l.length - 2]

  const hh = lastH.price > prevH.price  // Higher High
  const hl = lastL.price > prevL.price   // Higher Low
  const lh = lastH.price < prevH.price   // Lower High
  const ll = lastL.price < prevL.price   // Lower Low

  if (direction === 'long') {
    if (hh && hl) {
      return { bosConfirmed: true, choch: false, detail: `bullish BOS: HH $${lastH.price.toFixed(2)} + HL $${lastL.price.toFixed(2)}` }
    }
    // CHoCH: was bearish (LH+LL) but now made HH
    if (hh && ll) {
      return { bosConfirmed: false, choch: true, detail: `bullish CHoCH: HH $${lastH.price.toFixed(2)} breaking bearish sequence` }
    }
    // Partial: HH but no HL yet (or vice versa)
    if (hh) {
      return { bosConfirmed: false, choch: false, detail: `HH $${lastH.price.toFixed(2)} but no HL confirmation` }
    }
    return { bosConfirmed: false, choch: false, detail: 'no bullish structure' }
  } else {
    if (lh && ll) {
      return { bosConfirmed: true, choch: false, detail: `bearish BOS: LH $${lastH.price.toFixed(2)} + LL $${lastL.price.toFixed(2)}` }
    }
    // CHoCH: was bullish (HH+HL) but now made LL
    if (ll && hh) {
      return { bosConfirmed: false, choch: true, detail: `bearish CHoCH: LL $${lastL.price.toFixed(2)} breaking bullish sequence` }
    }
    if (ll) {
      return { bosConfirmed: false, choch: false, detail: `LL $${lastL.price.toFixed(2)} but no LH confirmation` }
    }
    return { bosConfirmed: false, choch: false, detail: 'no bearish structure' }
  }
}
