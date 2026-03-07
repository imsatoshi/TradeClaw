/**
 * Multi-factor setup scorer v2 — 8-dimension scoring system.
 *
 * Scores each (symbol, direction) pair on 8 dimensions (0-100 total):
 *   1. Trend Strength  (15) — EMA spread + SMA20
 *   2. Momentum        (15) — RSI + MACD + MTF RSI gate
 *   3. Acceleration    (10) — ROC delta (rate of change of rate of change)
 *   4. Structure       (20) — FVG + validated BOS sequence + CHoCH
 *   5. Candle Quality  (10) — body ratio + wick rejection + engulfing
 *   6. Volume          (10) — volume ratio (trend vs mean-reversion)
 *   7. Volatility      (10) — BBWP + absolute bandwidth
 *   8. Funding         (10) — funding rate alignment
 *
 * All indicator functions are reused from helpers.ts.
 */

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
  const detail = `EMA spread ${spread >= 0 ? '+' : ''}${spread.toFixed(2)}% (${spreadScore}/10), 1H SMA20 (${trendScore}/5)`
  return { score, max: 15, detail, raw: { emaSpreadPct: Math.round(spread * 1000) / 1000, regime: regime.regime } }
}

function scoreMomentum(
  direction: SignalDirection,
  closes15m: number[],
  bars1h: MarketData[],
  rsiPeriod: number,
): DimensionScore {
  // 15m RSI component (0-8)
  const rsiArr = rsiSeries(closes15m, rsiPeriod)
  let rsiScore = 0
  let rsiVal = 50

  if (rsiArr.length > 0) {
    rsiVal = rsiArr[rsiArr.length - 1]

    if (direction === 'long') {
      if (rsiVal >= 30 && rsiVal < 45) rsiScore = 8        // oversold recovery (ideal)
      else if (rsiVal >= 45 && rsiVal < 55) rsiScore = 5   // neutral
      else if (rsiVal >= 55 && rsiVal < 65) rsiScore = 3   // mildly overbought
      else if (rsiVal >= 65) rsiScore = 0                    // overbought — no long
      else if (rsiVal >= 25) rsiScore = 4                    // deeply oversold, bounce likely
      else rsiScore = 2                                       // < 25: extreme oversold
    } else {
      if (rsiVal > 55 && rsiVal <= 70) rsiScore = 8        // overbought recovery (ideal)
      else if (rsiVal > 45 && rsiVal <= 55) rsiScore = 5   // neutral
      else if (rsiVal > 35 && rsiVal <= 45) rsiScore = 3   // mildly oversold
      else if (rsiVal <= 35) rsiScore = 0                    // oversold — no short
      else if (rsiVal <= 75) rsiScore = 4                    // deeply overbought, drop likely
      else rsiScore = 2                                       // > 75: extreme overbought
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

  // 1H RSI MTF penalty (0 to -3)
  let mtfPenalty = 0
  let mtfDetail = ''
  if (bars1h.length >= 15) {
    const closes1h = bars1h.map(b => b.close)
    const rsi1h = rsiSeries(closes1h, 14)
    if (rsi1h.length > 0) {
      const rsi1hVal = rsi1h[rsi1h.length - 1]
      if (direction === 'long' && rsi1hVal > 70) {
        mtfPenalty = -3
        mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} OB penalty`
      } else if (direction === 'long' && rsi1hVal > 60) {
        mtfPenalty = -1
        mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} mild OB`
      } else if (direction === 'short' && rsi1hVal < 30) {
        mtfPenalty = -3
        mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} OS penalty`
      } else if (direction === 'short' && rsi1hVal < 40) {
        mtfPenalty = -1
        mtfDetail = `, 1H RSI ${rsi1hVal.toFixed(0)} mild OS`
      }
    }
  }

  const macdCurrent = macdHist.length > 0 ? macdHist[macdHist.length - 1] : 0
  const score = Math.max(0, rsiScore + macdScore + mtfPenalty)
  const detail = `RSI ${rsiVal.toFixed(0)} (${rsiScore}/8), MACD ${macdDetail} (${macdScore}/5)${mtfDetail}`
  return { score, max: 15, detail, raw: { rsi15m: Math.round(rsiVal * 10) / 10, macdHist: Math.round(macdCurrent * 10000) / 10000, macdAccelerating: macdHist.length >= 2 ? (direction === 'long' ? macdCurrent > macdHist[macdHist.length - 2] : macdCurrent < macdHist[macdHist.length - 2]) : false } }
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

  // Cap bonus at 4 to keep max at 20
  const bonusScore = Math.min(chochScore + liqScore, 4)

  const score = fvgScore + bosScore + bonusScore
  const detail = `${fvgDetail} (${fvgScore}/6), ${bosDetail} (${bosScore}/10)${chochDetail}${liqDetail}`
  return { score, max: 20, detail, raw: { hasFVG: fvgScore > 0, bosConfirmed: bosScore >= 6, hasCHoCH: chochScore > 0, hasLiqZone: liqScore > 0 } }
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

  // Extreme positive funding → favor short (fade)
  // Extreme negative funding → favor long (fade)
  if (rate > 0.0005 && direction === 'short') {
    score = 10; detail = `${ratePct.toFixed(3)}% (extreme +, fade short)`
  } else if (rate > 0.0003 && direction === 'short') {
    score = 7; detail = `${ratePct.toFixed(3)}% (high +, fade short)`
  } else if (rate < -0.0005 && direction === 'long') {
    score = 10; detail = `${ratePct.toFixed(3)}% (extreme -, fade long)`
  } else if (rate < -0.0003 && direction === 'long') {
    score = 7; detail = `${ratePct.toFixed(3)}% (high -, fade long)`
  } else if (Math.abs(rate) < 0.0001) {
    score = 5; detail = `${ratePct.toFixed(3)}% (neutral)`
  } else {
    // Funding goes against our direction
    score = 2; detail = `${ratePct.toFixed(3)}% (against direction)`
  }

  return { score, max: 10, detail, raw: { fundingRate: funding ? Math.round(funding.fundingRate * 1000000) / 1000000 : 0 } }
}

// ==================== Main Scorer ====================

export async function scoreSetup(
  symbol: string,
  direction: SignalDirection,
  regime: MarketRegime,
  bars: MarketData[],
  funding?: FundingRateInfo,
): Promise<SetupScore> {
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
  const momentum = scoreMomentum(direction, closes, bars, RSI_PERIOD)
  const acceleration = scoreAcceleration(direction, closes)
  const structure = scoreStructure(direction, closes, highs, lows, rsiArr, volumes, SWING_WINDOW)
  const candle = scoreCandleQuality(direction, bars)
  const volume = scoreVolume(regime.regime, volumes, VOL_AVG_PERIOD)
  const volatility = scoreVolatility(closes, BB_PERIOD, BB_MULT, BBWP_LOOKBACK)
  const fundingScore = scoreFunding(direction, funding)

  let totalScore = trend.score + momentum.score + acceleration.score + structure.score
    + candle.score + volume.score + volatility.score + fundingScore.score

  // Global volatility penalty: high BBWP (>70th percentile) makes all setups riskier
  const bbwpRaw = volatility.raw?.bbwp
  if (typeof bbwpRaw === 'number' && bbwpRaw > 70) {
    const volPenalty = bbwpRaw > 85 ? 15 : 10
    totalScore = Math.max(0, totalScore - volPenalty)
    volatility.detail += ` [HIGH-VOL PENALTY: -${volPenalty}]`
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
    },
    entry: null, // filled by entry-trigger.ts if score qualifies
  }
}
