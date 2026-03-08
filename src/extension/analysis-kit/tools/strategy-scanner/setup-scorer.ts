/**
 * Multi-factor setup scorer v3 — 9-dimension scoring system.
 *
 * Scores each (symbol, direction) pair on 9 dimensions (0-110 total):
 *   1. Trend Strength  (15) — EMA spread + SMA20
 *   2. Momentum        (20) — RSI + MACD + MTF RSI gate
 *   3. Acceleration    (10) — ROC delta (rate of change of rate of change)
 *   4. Structure       (15) — FVG + validated BOS sequence + CHoCH
 *   5. Candle Quality  (10) — body ratio + wick rejection + engulfing
 *   6. Volume          (10) — volume ratio (trend vs mean-reversion)
 *   7. Volatility      (10) — BBWP + absolute bandwidth
 *   8. Funding         (10) — funding rate alignment
 *   9. Crash Risk      (10) — multi-TF RSI_3 crash/capitulation detection
 *
 * All indicator functions are reused from helpers.ts.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import type { MarketRegime } from './regime.js'
import type { SetupScore, DimensionScore, SignalDirection, FundingRateInfo } from './types.js'
import {
  rsiSeries, macdHistogramSeries,
  findSwingHighs, findSwingLows,
  bandwidthSeries, sma, rocSeries,
  detectFVGs, validateBOSSequence,
  detectLiquidityZones,
} from './helpers.js'
import { getStrategyParamsFor } from './config.js'

// ==================== Dimension Scorers ====================

function scoreTrend(
  direction: SignalDirection,
  regime: MarketRegime,
  bars1h: MarketData[],
): DimensionScore {
  // EMA spread strength (0-10): continuous measure of trend strength
  let spreadScore = 0
  const spread = regime.emaSlow !== 0
    ? ((regime.emaFast - regime.emaSlow) / regime.emaSlow) * 100
    : 0

  // Compute spread delta: is the spread expanding or contracting?
  // Use 1H bars to estimate prior EMA spread (6 bars ago = ~6 hours)
  let spreadDelta = 0
  if (bars1h.length >= 16) {
    const closes1h = bars1h.map(b => b.close)
    const ema9 = sma(closes1h.slice(-15, -6), 9)  // rough EMA proxy 6 bars ago
    const ema55 = sma(closes1h.slice(-61, -6), Math.min(55, closes1h.length - 6))
    if (ema55 > 0) {
      const prevSpread = ((ema9 - ema55) / ema55) * 100
      spreadDelta = Math.abs(spread) - Math.abs(prevSpread)
    }
  }

  if (regime.regime === 'ranging') {
    spreadScore = 5 // neutral for ranging
  } else if (direction === 'long') {
    if (spread > 2) spreadScore = 10
    else if (spread > 1) spreadScore = 7
    else if (spread > 0.5) spreadScore = 4
    else spreadScore = 2
  } else {
    // SHORT: negative spread is good
    if (spread < -2) spreadScore = 10
    else if (spread < -1) spreadScore = 7
    else if (spread < -0.5) spreadScore = 4
    else spreadScore = 2
  }

  // Spread delta adjustment: expanding = +2, contracting = -2
  if (regime.regime !== 'ranging') {
    if (spreadDelta > 0.1) spreadScore = Math.min(10, spreadScore + 2)
    else if (spreadDelta < -0.1) spreadScore = Math.max(0, spreadScore - 2)
  }

  // 1H SMA20 confirmation (0-5)
  let trendScore = 3 // neutral default
  if (bars1h.length >= 20) {
    const closes1h = bars1h.map(b => b.close)
    const last1h = closes1h[closes1h.length - 1]
    const sma20 = closes1h.slice(-20).reduce((a, b) => a + b, 0) / 20

    if (direction === 'long') {
      if (last1h > sma20 * 1.005) trendScore = 5
      else if (last1h < sma20 * 0.995) trendScore = 0
    } else {
      if (last1h < sma20 * 0.995) trendScore = 5
      else if (last1h > sma20 * 1.005) trendScore = 0
    }
  }

  const score = spreadScore + trendScore
  const deltaLabel = spreadDelta > 0.1 ? ' expanding' : spreadDelta < -0.1 ? ' contracting' : ''
  const detail = `EMA spread ${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%${deltaLabel} (${spreadScore}/10), 1H SMA20 (${trendScore}/5)`
  return { score, max: 15, detail, raw: { emaSpreadPct: Math.round(spread * 1000) / 1000, spreadDelta: Math.round(spreadDelta * 1000) / 1000, regime: regime.regime } }
}

/**
 * Detect RSI divergence by comparing the last two swing lows (for long) or swing highs (for short).
 * Bullish divergence: price lower low + RSI higher low → selling pressure exhausted.
 * Bearish divergence: price higher high + RSI lower high → buying pressure exhausted.
 */
function detectRsiDivergence(
  closes: number[],
  rsiArr: number[],
  direction: SignalDirection,
  lookback = 30,
): boolean {
  // Align RSI with closes (RSI series is shorter by rsiPeriod)
  const offset = closes.length - rsiArr.length
  const startIdx = Math.max(0, rsiArr.length - lookback)

  if (direction === 'long') {
    // Find two most recent local minima in price
    const lows: { idx: number; price: number; rsi: number }[] = []
    for (let i = startIdx + 2; i < rsiArr.length - 1; i++) {
      const pi = i + offset
      if (closes[pi] < closes[pi - 1] && closes[pi] < closes[pi + 1]) {
        lows.push({ idx: i, price: closes[pi], rsi: rsiArr[i] })
      }
    }
    if (lows.length >= 2) {
      const prev = lows[lows.length - 2]
      const curr = lows[lows.length - 1]
      // Price lower low but RSI higher low = bullish divergence
      return curr.price < prev.price && curr.rsi > prev.rsi
    }
  } else {
    // Find two most recent local maxima in price
    const highs: { idx: number; price: number; rsi: number }[] = []
    for (let i = startIdx + 2; i < rsiArr.length - 1; i++) {
      const pi = i + offset
      if (closes[pi] > closes[pi - 1] && closes[pi] > closes[pi + 1]) {
        highs.push({ idx: i, price: closes[pi], rsi: rsiArr[i] })
      }
    }
    if (highs.length >= 2) {
      const prev = highs[highs.length - 2]
      const curr = highs[highs.length - 1]
      // Price higher high but RSI lower high = bearish divergence
      return curr.price > prev.price && curr.rsi < prev.rsi
    }
  }
  return false
}

// v5→v6: Mean-reversion token list loaded from data/config/tokens.json
let _meanRevTokens: Set<string> | null = null
function getMeanReversionTokens(): Set<string> {
  if (_meanRevTokens) return _meanRevTokens
  try {
    const raw = readFileSync(resolve('data/config/tokens.json'), 'utf-8')
    const cfg = JSON.parse(raw) as { meanReversionTokens?: string[] }
    _meanRevTokens = new Set(cfg.meanReversionTokens ?? [])
  } catch {
    _meanRevTokens = new Set(['DOGE/USDT', 'SHIB/USDT', 'XRP/USDT', 'PEPE/USDT', 'FLOKI/USDT', 'WIF/USDT', 'BONK/USDT', 'MEME/USDT'])
  }
  return _meanRevTokens
}

function scoreMomentum(
  direction: SignalDirection,
  closes15m: number[],
  bars1h: MarketData[],
  rsiPeriod: number,
  symbol?: string,
): DimensionScore {
  // 15m RSI component (0-8) — requires divergence for extreme zones
  const rsiArr = rsiSeries(closes15m, rsiPeriod)
  let rsiScore = 0
  let rsiVal = 50
  let divergenceNote = ''

  if (rsiArr.length > 0) {
    rsiVal = rsiArr[rsiArr.length - 1]

    // Detect RSI divergence: compare RSI at recent swing lows/highs
    // Bullish divergence: price makes lower low but RSI makes higher low
    // Bearish divergence: price makes higher high but RSI makes lower high
    const hasDivergence = detectRsiDivergence(closes15m, rsiArr, direction)

    if (direction === 'long') {
      if (rsiVal >= 30 && rsiVal < 45) {
        // Oversold zone — only high score if divergence confirms exhaustion
        rsiScore = hasDivergence ? 8 : 4
        if (hasDivergence) divergenceNote = ' (bullish div)'
      } else if (rsiVal >= 45 && rsiVal < 55) rsiScore = 5   // neutral
      else if (rsiVal >= 55 && rsiVal < 65) rsiScore = 3   // mildly overbought
      else if (rsiVal >= 65) rsiScore = 0                    // overbought — no long
      else if (rsiVal >= 25) {
        // Deeply oversold — could be cascade or bounce, divergence decides
        rsiScore = hasDivergence ? 6 : 1
        if (!hasDivergence) divergenceNote = ' (no div, cascade risk)'
      }
      else rsiScore = 1                                       // < 25: extreme, likely cascade
    } else {
      if (rsiVal > 55 && rsiVal <= 70) {
        rsiScore = hasDivergence ? 8 : 4
        if (hasDivergence) divergenceNote = ' (bearish div)'
      } else if (rsiVal > 45 && rsiVal <= 55) rsiScore = 5   // neutral
      else if (rsiVal > 35 && rsiVal <= 45) rsiScore = 3   // mildly oversold
      else if (rsiVal <= 35) rsiScore = 0                    // oversold — no short
      else if (rsiVal <= 75) {
        rsiScore = hasDivergence ? 6 : 1
        if (!hasDivergence) divergenceNote = ' (no div, squeeze risk)'
      }
      else rsiScore = 1                                       // > 75: extreme
    }
  }

  // MACD histogram component (0-5)
  const macdHist = macdHistogramSeries(closes15m)
  let macdScore = 1 // neutral default
  let macdDetail = 'neutral'

  if (macdHist.length >= 2) {
    const current = macdHist[macdHist.length - 1]
    const prev = macdHist[macdHist.length - 2]
    const inDirection = direction === 'long' ? current > 0 : current < 0
    const accelerating = direction === 'long'
      ? current > prev
      : current < prev

    if (inDirection && accelerating) {
      macdScore = 5
      macdDetail = 'in direction + accelerating'
    } else if (inDirection) {
      macdScore = 3
      macdDetail = 'in direction, decelerating'
    } else {
      macdScore = 0
      macdDetail = 'against direction'
    }
  }

  // 1H RSI MTF penalty — direction-aware (0 to -3)
  // If 1H EMA trend aligns with our direction, high RSI is normal extension → no penalty.
  // If against our direction → heavier penalty.
  let mtfPenalty = 0
  let mtfDetail = ''
  if (bars1h.length >= 15) {
    const closes1h = bars1h.map(b => b.close)
    const rsi1h = rsiSeries(closes1h, 14)
    if (rsi1h.length > 0) {
      const rsi1hVal = rsi1h[rsi1h.length - 1]
      // Check 1H EMA direction: use SMA9 vs SMA21 as proxy
      const sma9_1h = closes1h.length >= 9 ? sma(closes1h.slice(-9), 9) : 0
      const sma21_1h = closes1h.length >= 21 ? sma(closes1h.slice(-21), 21) : 0
      const ema1hBullish = sma9_1h > sma21_1h
      const ema1hBearish = sma9_1h < sma21_1h

      // v5: Mean-reversion tokens get stricter MTF penalty (lower threshold, heavier penalty)
      const isMeanRev = symbol ? getMeanReversionTokens().has(symbol) : false
      const obThreshold = isMeanRev ? 65 : 70
      const osThreshold = isMeanRev ? 35 : 30
      const heavyPenalty = isMeanRev ? -5 : -3
      const mildObThreshold = isMeanRev ? 55 : 60
      const mildOsThreshold = isMeanRev ? 45 : 40

      if (direction === 'long' && rsi1hVal > obThreshold) {
        if (ema1hBullish && !isMeanRev) {
          // 1H uptrend + RSI OB = normal extension, skip penalty (not for mean-rev tokens)
          mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} OB (trend-aligned, no penalty)`
        } else {
          mtfPenalty = heavyPenalty
          mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} OB penalty${isMeanRev ? ' (mean-rev token)' : ' (counter-trend)'}`
        }
      } else if (direction === 'long' && rsi1hVal > mildObThreshold) {
        if (!ema1hBullish || isMeanRev) {
          mtfPenalty = isMeanRev ? -2 : -1
          mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} mild OB${isMeanRev ? ' (mean-rev)' : ''}`
        }
      } else if (direction === 'short' && rsi1hVal < osThreshold) {
        if (ema1hBearish && !isMeanRev) {
          mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} OS (trend-aligned, no penalty)`
        } else {
          mtfPenalty = heavyPenalty
          mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} OS penalty${isMeanRev ? ' (mean-rev token)' : ' (counter-trend)'}`
        }
      } else if (direction === 'short' && rsi1hVal < mildOsThreshold) {
        if (!ema1hBearish || isMeanRev) {
          mtfPenalty = isMeanRev ? -2 : -1
          mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} mild OS${isMeanRev ? ' (mean-rev)' : ''}`
        }
      }
    }
  }

  const macdCurrent = macdHist.length > 0 ? macdHist[macdHist.length - 1] : 0
  const score = Math.max(0, rsiScore + macdScore + mtfPenalty)
  const detail = `RSI ${rsiVal.toFixed(0)}${divergenceNote} (${rsiScore}/8), MACD ${macdDetail} (${macdScore}/5)${mtfDetail}`
  return { score, max: 20, detail, raw: { rsi15m: Math.round(rsiVal * 10) / 10, macdHist: Math.round(macdCurrent * 10000) / 10000, macdAccelerating: macdHist.length >= 2 ? (direction === 'long' ? macdCurrent > macdHist[macdHist.length - 2] : macdCurrent < macdHist[macdHist.length - 2]) : false } }
}

function scoreAcceleration(
  direction: SignalDirection,
  closes15m: number[],
): DimensionScore {
  const roc5 = rocSeries(closes15m, 5)

  if (roc5.length < 10) {
    return { score: 5, max: 10, detail: 'insufficient data' }
  }

  // Acceleration = change in ROC over last 5 bars
  const rocDelta = roc5[roc5.length - 1] - roc5[roc5.length - 6]

  let score: number
  if (direction === 'long') {
    if (rocDelta > 0.5) score = 10
    else if (rocDelta > 0.2) score = 7
    else if (rocDelta > 0) score = 4
    else score = 1
  } else {
    // SHORT: negative acceleration (momentum accelerating down) is good
    if (rocDelta < -0.5) score = 10
    else if (rocDelta < -0.2) score = 7
    else if (rocDelta < 0) score = 4
    else score = 1
  }

  const detail = `ROC delta ${rocDelta >= 0 ? '+' : ''}${rocDelta.toFixed(3)}`
  return { score, max: 10, detail, raw: { rocDelta: Math.round(rocDelta * 10000) / 10000 } }
}

function scoreStructure(
  direction: SignalDirection,
  closes15m: number[],
  highs15m: number[],
  lows15m: number[],
  rsiArr: number[],
  volumes15m: number[],
  swingWindow: number,
): DimensionScore {
  const currentPrice = closes15m[closes15m.length - 1]

  // Align arrays for swing detection
  const rsiPeriod = closes15m.length - rsiArr.length
  const offset = rsiPeriod
  const aHighs = highs15m.slice(offset)
  const aLows = lows15m.slice(offset)
  const aVols = volumes15m.slice(offset)
  const len = Math.min(aHighs.length, rsiArr.length, aVols.length)

  const hSlice = aHighs.slice(0, len)
  const lSlice = aLows.slice(0, len)
  const rSlice = rsiArr.slice(0, len)
  const vSlice = aVols.slice(0, len)

  const swingHighs = findSwingHighs(hSlice, rSlice, vSlice, swingWindow)
  const swingLows = findSwingLows(lSlice, rSlice, vSlice, swingWindow)

  // --- FVG proximity (0-6) ---
  let fvgScore = 0
  let fvgDetail = 'no FVG'

  // Use full aligned highs/lows for FVG detection
  const fvgs = detectFVGs(hSlice, lSlice, direction)
  if (fvgs.length > 0) {
    // Find the nearest FVG to current price (look at last 30 bars)
    const recentFVGs = fvgs.filter(f => len - 1 - f.index <= 30)
    for (const fvg of recentFVGs.reverse()) {
      const gapMid = (fvg.gapHigh + fvg.gapLow) / 2
      const distPct = Math.abs((currentPrice - gapMid) / gapMid) * 100

      // Check if price is within or near the FVG
      const inGap = currentPrice >= fvg.gapLow && currentPrice <= fvg.gapHigh
      if (inGap || distPct <= 0.5) {
        fvgScore = 6
        fvgDetail = `in FVG $${fvg.gapLow.toFixed(2)}-$${fvg.gapHigh.toFixed(2)}`
        break
      } else if (distPct <= 1.0) {
        fvgScore = 3
        fvgDetail = `near FVG $${fvg.gapLow.toFixed(2)}-$${fvg.gapHigh.toFixed(2)} (${distPct.toFixed(1)}%)`
        break
      }
    }
  }

  // --- BOS validation (0-10) ---
  let bosScore = 0
  let bosDetail = 'no BOS'

  const bosResult = validateBOSSequence(swingHighs, swingLows, direction)
  if (bosResult.bosConfirmed) {
    // Check recency: latest swing should be within 20 bars
    const relevantSwing = direction === 'long'
      ? swingHighs[swingHighs.length - 1]
      : swingLows[swingLows.length - 1]
    const age = relevantSwing ? len - 1 - relevantSwing.index : 999

    if (age <= 20) {
      bosScore = 10
      bosDetail = bosResult.detail
    } else {
      bosScore = 6
      bosDetail = `${bosResult.detail} (${age} bars ago)`
    }
  } else if (bosResult.detail.includes('HH') || bosResult.detail.includes('LL')) {
    // Partial BOS (e.g. HH but no HL)
    bosScore = 3
    bosDetail = bosResult.detail
  }

  // --- CHoCH bonus (0-4) ---
  let chochScore = 0
  let chochDetail = ''

  if (bosResult.choch) {
    chochScore = 4
    chochDetail = `, CHoCH +4`
  }

  // --- Liquidity zone proximity (0-4, can stack with CHoCH up to combined cap) ---
  let liqScore = 0
  let liqDetail = ''

  const liqZones = detectLiquidityZones(swingHighs, swingLows)
  if (liqZones.length > 0) {
    // Find nearest relevant liquidity zone
    const relevantZones = direction === 'long'
      ? liqZones.filter(lz => lz.type === 'equal_lows')  // EQL below = support magnet
      : liqZones.filter(lz => lz.type === 'equal_highs') // EQH above = resistance magnet

    for (const lz of relevantZones) {
      const distPct = Math.abs((currentPrice - lz.price) / lz.price) * 100
      if (distPct <= 1.5) {
        liqScore = lz.count >= 3 ? 4 : 3
        liqDetail = `, ${lz.type} $${lz.price.toFixed(2)} (${lz.count}x, ${distPct.toFixed(1)}%) +${liqScore}`
        break
      }
    }
  }

  // Cap bonus at 4 to keep max at 15
  const bonusScore = Math.min(chochScore + liqScore, 4)

  let score = fvgScore + bosScore + bonusScore
  score = Math.min(score, 15)
  const detail = `${fvgDetail} (${fvgScore}/6), ${bosDetail} (${bosScore}/10)${chochDetail}${liqDetail}`
  return { score, max: 15, detail, raw: { hasFVG: fvgScore > 0, bosConfirmed: bosScore >= 6, hasCHoCH: chochScore > 0, hasLiqZone: liqScore > 0 } }
}

function scoreCandleQuality(
  direction: SignalDirection,
  bars: MarketData[],
): DimensionScore {
  if (bars.length < 2) return { score: 5, max: 10, detail: 'insufficient data' }

  const current = bars[bars.length - 1]
  const prev = bars[bars.length - 2]

  const body = Math.abs(current.close - current.open)
  const range = current.high - current.low
  const isBullish = current.close > current.open

  // Body-to-range ratio (0-4)
  let bodyScore = 0
  const bodyRatio = range > 0 ? body / range : 0
  if (bodyRatio > 0.7) bodyScore = 4
  else if (bodyRatio > 0.5) bodyScore = 2
  // < 0.3 or doji = 0

  // Wick rejection (0-3)
  let wickScore = 0
  let wickDetail = ''
  if (range > 0) {
    const upperWick = current.high - Math.max(current.close, current.open)
    const lowerWick = Math.min(current.close, current.open) - current.low
    const closePos = (current.close - current.low) / range // 0 = bottom, 1 = top

    if (direction === 'long') {
      // Lower wick rejection: strong buying pressure from below
      if (body > 0 && lowerWick > body * 2 && closePos > 0.66) {
        wickScore = 3
        wickDetail = 'strong lower wick rejection'
      } else if (body > 0 && lowerWick > body && closePos > 0.5) {
        wickScore = 1
        wickDetail = 'lower wick'
      }
    } else {
      // Upper wick rejection: strong selling pressure from above
      if (body > 0 && upperWick > body * 2 && closePos < 0.33) {
        wickScore = 3
        wickDetail = 'strong upper wick rejection'
      } else if (body > 0 && upperWick > body && closePos < 0.5) {
        wickScore = 1
        wickDetail = 'upper wick'
      }
    }
  }

  // Engulfing pattern (0-3)
  let engulfScore = 0
  let engulfDetail = ''
  const prevBullish = prev.close > prev.open
  const prevBody = Math.abs(prev.close - prev.open)

  if (direction === 'long' && isBullish && !prevBullish && prevBody > 0) {
    // Bullish engulfing: current close > prev open, current open < prev close
    if (current.close > prev.open && current.open < prev.close) {
      engulfScore = 3
      engulfDetail = 'bullish engulfing'
    }
  } else if (direction === 'short' && !isBullish && prevBullish && prevBody > 0) {
    // Bearish engulfing: current close < prev open, current open > prev close
    if (current.close < prev.open && current.open > prev.close) {
      engulfScore = 3
      engulfDetail = 'bearish engulfing'
    }
  }

  const score = bodyScore + wickScore + engulfScore
  const details = [
    `body ${(bodyRatio * 100).toFixed(0)}% (${bodyScore}/4)`,
    wickDetail || 'no wick signal',
    engulfDetail || 'no engulfing',
  ].join(', ')

  return { score, max: 10, detail: details, raw: { bodyRatio: Math.round(bodyRatio * 100) / 100, hasWickRejection: wickScore > 0, hasEngulfing: engulfScore > 0 } }
}

function scoreVolume(
  regime: MarketRegime['regime'],
  volumes15m: number[],
  volAvgPeriod: number,
): DimensionScore {
  const avgVol = sma(volumes15m.slice(0, -3), Math.min(volAvgPeriod, volumes15m.length - 3))
  // Use average of last 3 candles to smooth single-bar noise
  const recent3 = volumes15m.slice(-3)
  const currentVol = recent3.reduce((s, v) => s + v, 0) / recent3.length
  const volRatio = avgVol > 0 ? currentVol / avgVol : 1

  let score: number
  let detail: string

  if (regime === 'uptrend' || regime === 'downtrend') {
    // Trend mode: high volume = strong confirmation
    if (volRatio > 1.5) { score = 10; detail = `${volRatio.toFixed(1)}x avg (strong trend confirm)` }
    else if (volRatio > 1.2) { score = 7; detail = `${volRatio.toFixed(1)}x avg (confirm)` }
    else if (volRatio >= 0.8) { score = 4; detail = `${volRatio.toFixed(1)}x avg (normal)` }
    else { score = 1; detail = `${volRatio.toFixed(1)}x avg (weak)` }
  } else {
    // Ranging mode: prefer normal-to-slightly-low volume; very low = dead market (risky), high = breakout incoming
    if (volRatio >= 0.8 && volRatio <= 1.2) { score = 7; detail = `${volRatio.toFixed(1)}x avg (ideal for ranging)` }
    else if (volRatio < 0.8 && volRatio >= 0.5) { score = 4; detail = `${volRatio.toFixed(1)}x avg (low, caution)` }
    else if (volRatio < 0.5) { score = 1; detail = `${volRatio.toFixed(1)}x avg (dead market)` }
    else if (volRatio <= 1.5) { score = 3; detail = `${volRatio.toFixed(1)}x avg (elevated for ranging)` }
    else { score = 0; detail = `${volRatio.toFixed(1)}x avg (breakout volume, skip mean-reversion)` }
  }

  return { score, max: 10, detail, raw: { volumeRatio: Math.round(volRatio * 100) / 100 } }
}

function scoreVolatility(
  closes15m: number[],
  bbPeriod: number,
  bbMult: number,
  bbwpLookback: number,
): DimensionScore {
  // Absolute bandwidth check
  const bbSlice = closes15m.slice(-bbPeriod)
  if (bbSlice.length < bbPeriod) return { score: 5, max: 10, detail: 'insufficient data' }

  const middle = bbSlice.reduce((s, v) => s + v, 0) / bbPeriod
  const variance = bbSlice.reduce((s, v) => s + (v - middle) ** 2, 0) / bbPeriod
  const stdDev = Math.sqrt(variance)
  const upper = middle + bbMult * stdDev
  const lower = middle - bbMult * stdDev
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0

  // Hard limits
  if (bandwidth > 12 || bandwidth < 1.5) {
    return { score: 0, max: 10, detail: `BW ${bandwidth.toFixed(1)}% (extreme)` }
  }

  // BBWP: percentile of current bandwidth in recent history
  const bwSeries = bandwidthSeries(closes15m, bbPeriod, bbMult)
  let bbwp = 50

  if (bwSeries.length >= 20) {
    const lookbackSlice = bwSeries.slice(-Math.min(bbwpLookback, bwSeries.length))
    const currentBw = bwSeries[bwSeries.length - 1]
    const belowCount = lookbackSlice.filter(bw => bw < currentBw).length
    bbwp = (belowCount / lookbackSlice.length) * 100
  }

  let score: number
  if (bbwp >= 20 && bbwp <= 60) { score = 10 }
  else if (bbwp > 60 && bbwp <= 80) { score = 5 }
  else if (bbwp < 20) { score = 2 }
  else { score = 0 } // > 80

  const detail = `BBWP ${bbwp.toFixed(0)}, BW ${bandwidth.toFixed(1)}%`
  return { score, max: 10, detail, raw: { bbwp: Math.round(bbwp), bandwidthPct: Math.round(bandwidth * 10) / 10 } }
}

function scoreFunding(
  direction: SignalDirection,
  funding?: FundingRateInfo,
): DimensionScore {
  if (!funding) return { score: 3, max: 10, detail: 'no data (penalized)' }

  const rate = funding.fundingRate
  const ratePct = rate * 100 // e.g. 0.0001 → 0.01%
  let score: number
  let detail: string

  // Conservative funding scoring:
  // Extreme funding = strong trend momentum. Don't blindly fade.
  // - Extreme in OUR direction = trend confirmation (moderate score)
  // - Extreme AGAINST our direction = caution, not auto-fade
  //   (fading requires rate declining from peak, which we can't detect without history)
  // - Neutral = safe (good score)
  if (Math.abs(rate) < 0.0001) {
    score = 6; detail = `${ratePct.toFixed(3)}% (neutral, safe)`
  } else if (rate > 0.0005) {
    if (direction === 'short') {
      // Extreme positive funding, wanting to short — crowded long, BUT could still squeeze higher
      score = 5; detail = `${ratePct.toFixed(3)}% (extreme +, possible fade but risky without rate decline)`
    } else {
      // Extreme positive funding, wanting to long — very crowded, caution
      score = 1; detail = `${ratePct.toFixed(3)}% (extreme +, crowded longs, risky for more long)`
    }
  } else if (rate > 0.0003) {
    if (direction === 'short') {
      score = 5; detail = `${ratePct.toFixed(3)}% (high +, potential fade)`
    } else {
      score = 2; detail = `${ratePct.toFixed(3)}% (high +, crowded side)`
    }
  } else if (rate < -0.0005) {
    if (direction === 'long') {
      score = 5; detail = `${ratePct.toFixed(3)}% (extreme -, possible fade but risky without rate decline)`
    } else {
      score = 1; detail = `${ratePct.toFixed(3)}% (extreme -, crowded shorts, risky for more short)`
    }
  } else if (rate < -0.0003) {
    if (direction === 'long') {
      score = 5; detail = `${ratePct.toFixed(3)}% (high -, potential fade)`
    } else {
      score = 2; detail = `${ratePct.toFixed(3)}% (high -, crowded side)`
    }
  } else {
    // Mild funding, aligned or not
    const aligned = (rate > 0 && direction === 'long') || (rate < 0 && direction === 'short')
    score = aligned ? 4 : 3
    detail = `${ratePct.toFixed(3)}% (mild, ${aligned ? 'aligned' : 'neutral'})`
  }

  return { score, max: 10, detail, raw: { fundingRate: Math.round(funding.fundingRate * 1000000) / 1000000 } }
}

// ==================== Crash / Capitulation Detector ====================

/**
 * Multi-timeframe RSI_3 crash detector.
 * Inspired by NFIX7's 6800-line protections_long_global — but instead of
 * hard-coded AND chains, we compute a crash score and expose raw RSI_3 values
 * for the AI to reason about independently.
 *
 * Score logic:
 *   - Each TF with RSI_3 < 15 (long) or > 85 (short) adds penalty
 *   - 3+ TFs in extreme = "severe crash" → large penalty
 *   - Capitulation (all TFs extreme oversold) → actually bullish signal
 */
export function scoreCrashRisk(
  direction: SignalDirection,
  bars1h: MarketData[],
  bars4h?: MarketData[],
): DimensionScore {
  const closes1h = bars1h.map(b => b.close)
  const rsi3_1h_arr = rsiSeries(closes1h, 3)
  const rsi3_1h = rsi3_1h_arr.length > 0 ? rsi3_1h_arr[rsi3_1h_arr.length - 1] : 50

  let rsi3_4h = 50
  if (bars4h && bars4h.length >= 10) {
    const closes4h = bars4h.map(b => b.close)
    const rsi3_4h_arr = rsiSeries(closes4h, 3)
    if (rsi3_4h_arr.length > 0) rsi3_4h = rsi3_4h_arr[rsi3_4h_arr.length - 1]
  }

  // Count extreme timeframes
  const isLong = direction === 'long'
  const extremeThreshold = 15
  let extremeCount = 0
  if (isLong) {
    if (rsi3_1h < extremeThreshold) extremeCount++
    if (rsi3_4h < extremeThreshold) extremeCount++
  } else {
    if (rsi3_1h > (100 - extremeThreshold)) extremeCount++
    if (rsi3_4h > (100 - extremeThreshold)) extremeCount++
  }

  // Determine crash severity
  let severity: 'none' | 'mild' | 'severe' | 'capitulation' = 'none'
  let score = 10 // max = 10, no crash = full score

  if (extremeCount >= 2) {
    // Both TFs in extreme — check for capitulation vs crash
    const bothDeepExtreme = isLong
      ? (rsi3_1h < 5 && rsi3_4h < 10)
      : (rsi3_1h > 95 && rsi3_4h > 90)

    if (bothDeepExtreme) {
      severity = 'capitulation'
      score = 8 // capitulation can be a reversal opportunity — mild penalty
    } else {
      severity = 'severe'
      score = 0 // severe crash, block entries
    }
  } else if (extremeCount === 1) {
    severity = 'mild'
    score = 4 // caution
  }

  const detail = severity === 'none'
    ? `RSI3 normal (1h:${rsi3_1h.toFixed(0)}, 4h:${rsi3_4h.toFixed(0)})`
    : `${severity.toUpperCase()} — RSI3 1h:${rsi3_1h.toFixed(0)}, 4h:${rsi3_4h.toFixed(0)}`

  return {
    score,
    max: 10,
    detail,
    raw: {
      rsi3_1h: Math.round(rsi3_1h * 10) / 10,
      rsi3_4h: Math.round(rsi3_4h * 10) / 10,
      crashSeverity: severity,
    },
  }
}

// ==================== Main Scorer ====================

export async function scoreSetup(
  symbol: string,
  direction: SignalDirection,
  regime: MarketRegime,
  bars: MarketData[],
  funding?: FundingRateInfo,
  bars4h?: MarketData[],
): Promise<SetupScore> {
  // Safety: warn if regime is missing or unexpected
  if (!regime?.regime) {
    console.warn(`setup-scorer: regime is null/undefined for ${symbol}, scoring confidence reduced`)
  }

  // Load configurable params (reuses existing config system)
  const p = await getStrategyParamsFor('pipeline', symbol)

  const RSI_PERIOD = p.rsiPeriod ?? 14
  const SWING_WINDOW = p.swingWindow ?? 5
  const VOL_AVG_PERIOD = p.volAvgPeriod ?? 20
  const BB_PERIOD = p.bbPeriod ?? 20
  const BB_MULT = p.bbMultiplier ?? 2
  const BBWP_LOOKBACK = p.bwPercentileLookback ?? 120

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const volumes = bars.map(b => b.volume)

  const rsiArr = rsiSeries(closes, RSI_PERIOD)

  const trend = scoreTrend(direction, regime, bars)
  const momentum = scoreMomentum(direction, closes, bars, RSI_PERIOD, symbol)
  const acceleration = scoreAcceleration(direction, closes)
  const structure = scoreStructure(direction, closes, highs, lows, rsiArr, volumes, SWING_WINDOW)
  const candle = scoreCandleQuality(direction, bars)
  const volume = scoreVolume(regime.regime, volumes, VOL_AVG_PERIOD)
  const volatility = scoreVolatility(closes, BB_PERIOD, BB_MULT, BBWP_LOOKBACK)
  const fundingScore = scoreFunding(direction, funding)
  const crashRisk = scoreCrashRisk(direction, bars, bars4h)

  let totalScore = trend.score + momentum.score + acceleration.score + structure.score
    + candle.score + volume.score + volatility.score + fundingScore.score + crashRisk.score

  // Regime-aware volatility penalty/bonus:
  // Trending + high BBWP = trend acceleration (bonus)
  // Ranging + high BBWP = whipsaw risk (penalty)
  const bbwpRaw = volatility.raw?.bbwp
  if (typeof bbwpRaw === 'number' && bbwpRaw > 70) {
    const isTrending = regime.regime === 'uptrend' || regime.regime === 'downtrend'
    if (isTrending) {
      // High vol in trend = acceleration confirmation — small bonus
      const volBonus = bbwpRaw > 85 ? 5 : 3
      totalScore += volBonus
      volatility.detail += ` [TREND-VOL BOOST: +${volBonus}]`
    } else {
      // High vol in ranging = whipsaw danger — penalty
      const volPenalty = bbwpRaw > 85 ? 15 : 10
      totalScore = Math.max(0, totalScore - volPenalty)
      volatility.detail += ` [RANGE-VOL PENALTY: -${volPenalty}]`
    }
  }

  return {
    symbol,
    direction,
    totalScore,
    regime: regime.regime,
    dimensions: {
      trend,
      momentum,
      acceleration,
      structure,
      candle,
      volume,
      volatility,
      funding: fundingScore,
      crashRisk,
    },
    entry: null, // filled by entry-trigger.ts if score qualifies
  }
}
