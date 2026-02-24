/**
 * Multi-factor setup scorer — replaces independent strategy confluence.
 *
 * Scores each (symbol, direction) pair on 6 dimensions (0-100 total):
 *   1. Trend Alignment (25) — 4H regime + 1H SMA20
 *   2. Momentum (20)        — 15m RSI + MACD histogram
 *   3. Structure (20)       — swing proximity + break of structure
 *   4. Volume (15)          — volume ratio (trend vs mean-reversion)
 *   5. Volatility (10)      — BBWP + absolute bandwidth
 *   6. Funding (10)         — funding rate alignment
 *
 * All indicator functions are reused from helpers.ts.
 */

import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import type { MarketRegime } from './regime.js'
import type { SetupScore, DimensionScore, SignalDirection, FundingRateInfo } from './types.js'
import {
  rsiSeries, macdHistogramSeries, emaSeries,
  findSwingHighs, findSwingLows, atrSeries,
  bandwidthSeries, sma,
} from './helpers.js'
import { getStrategyParamsFor } from './config.js'

// ==================== Dimension Scorers ====================

function scoreTrend(
  direction: SignalDirection,
  regime: MarketRegime,
  bars1h: MarketData[],
): DimensionScore {
  // 4H regime match (0-15)
  let regimeScore = 0
  if (
    (regime.regime === 'uptrend' && direction === 'long') ||
    (regime.regime === 'downtrend' && direction === 'short')
  ) {
    regimeScore = 15
  } else if (regime.regime === 'ranging') {
    regimeScore = 8
  }
  // counter-trend already filtered by Stage 1, but just in case:
  // regimeScore = 0 for uptrend+short or downtrend+long

  // 1H SMA20 trend match (0-10)
  let trendScore = 5 // neutral default
  if (bars1h.length >= 20) {
    const closes1h = bars1h.map(b => b.close)
    const last1h = closes1h[closes1h.length - 1]
    const sma20 = closes1h.slice(-20).reduce((a, b) => a + b, 0) / 20

    if (direction === 'long') {
      if (last1h > sma20 * 1.005) trendScore = 10
      else if (last1h < sma20 * 0.995) trendScore = 0
    } else {
      if (last1h < sma20 * 0.995) trendScore = 10
      else if (last1h > sma20 * 1.005) trendScore = 0
    }
  }

  const score = regimeScore + trendScore
  const detail = `4H ${regime.regime} (${regimeScore}/15), 1H SMA20 (${trendScore}/10)`
  return { score, max: 25, detail }
}

function scoreMomentum(
  direction: SignalDirection,
  closes15m: number[],
  rsiPeriod: number,
): DimensionScore {
  // RSI component (0-12)
  const rsiArr = rsiSeries(closes15m, rsiPeriod)
  let rsiScore = 0
  let rsiVal = 50

  if (rsiArr.length > 0) {
    rsiVal = rsiArr[rsiArr.length - 1]

    if (direction === 'long') {
      if (rsiVal >= 30 && rsiVal < 45) rsiScore = 12      // oversold recovery (ideal)
      else if (rsiVal >= 45 && rsiVal < 55) rsiScore = 8   // neutral
      else if (rsiVal >= 55 && rsiVal < 65) rsiScore = 5   // mildly overbought
      else if (rsiVal >= 65 && rsiVal < 70) rsiScore = 2   // approaching overbought
      else if (rsiVal >= 70) rsiScore = 0                   // overbought — no long
      else if (rsiVal >= 25 && rsiVal < 30) rsiScore = 6   // deeply oversold, bounce likely
      else rsiScore = 3                                      // < 25: extreme oversold
    } else {
      if (rsiVal > 55 && rsiVal <= 70) rsiScore = 12       // overbought recovery (ideal)
      else if (rsiVal > 45 && rsiVal <= 55) rsiScore = 8   // neutral
      else if (rsiVal > 35 && rsiVal <= 45) rsiScore = 5   // mildly oversold
      else if (rsiVal > 30 && rsiVal <= 35) rsiScore = 2   // approaching oversold
      else if (rsiVal <= 30) rsiScore = 0                   // oversold — no short
      else if (rsiVal > 70 && rsiVal <= 75) rsiScore = 6   // deeply overbought, drop likely
      else rsiScore = 3                                      // > 75: extreme overbought
    }
  }

  // MACD histogram component (0-8)
  const macdHist = macdHistogramSeries(closes15m)
  let macdScore = 2 // neutral default
  let macdDetail = 'neutral'

  if (macdHist.length >= 2) {
    const current = macdHist[macdHist.length - 1]
    const prev = macdHist[macdHist.length - 2]
    const inDirection = direction === 'long' ? current > 0 : current < 0
    const accelerating = direction === 'long'
      ? current > prev
      : current < prev

    // Zero-line reference: average absolute value of recent 10 bars
    const recentSlice = macdHist.slice(-Math.min(10, macdHist.length))
    const avgAbsHist = recentSlice.reduce((s, v) => s + Math.abs(v), 0) / recentSlice.length

    if (inDirection && accelerating) {
      macdScore = 8
      macdDetail = 'in direction + accelerating'
    } else if (inDirection) {
      macdScore = 5
      macdDetail = 'in direction, decelerating'
    } else if (avgAbsHist > 0 && Math.abs(current) < avgAbsHist * 0.2) {
      macdScore = 2
      macdDetail = 'near zero'
    } else {
      macdScore = 0
      macdDetail = 'against direction'
    }
  }

  const score = rsiScore + macdScore
  const detail = `RSI ${rsiVal.toFixed(0)} (${rsiScore}/12), MACD ${macdDetail} (${macdScore}/8)`
  return { score, max: 20, detail }
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
  const aCloses = closes15m.slice(offset)
  const aVols = volumes15m.slice(offset)
  const len = Math.min(aHighs.length, rsiArr.length, aVols.length)

  const hSlice = aHighs.slice(0, len)
  const lSlice = aLows.slice(0, len)
  const rSlice = rsiArr.slice(0, len)
  const vSlice = aVols.slice(0, len)

  // Swing proximity (0-12)
  let proximityScore = 4 // default: no nearby level
  let proximityDetail = 'no nearby level'

  if (direction === 'long') {
    const swingLows = findSwingLows(lSlice, rSlice, vSlice, swingWindow)
    if (swingLows.length > 0) {
      const nearest = swingLows[swingLows.length - 1]
      const distPct = ((currentPrice - nearest.price) / nearest.price) * 100
      if (distPct >= 0 && distPct <= 1) {
        proximityScore = 12
        proximityDetail = `at support $${nearest.price.toFixed(2)} (${distPct.toFixed(1)}%)`
      } else if (distPct >= 0 && distPct <= 2) {
        proximityScore = 8
        proximityDetail = `near support $${nearest.price.toFixed(2)} (${distPct.toFixed(1)}%)`
      }
    }
  } else {
    const swingHighs = findSwingHighs(hSlice, rSlice, vSlice, swingWindow)
    if (swingHighs.length > 0) {
      const nearest = swingHighs[swingHighs.length - 1]
      const distPct = ((nearest.price - currentPrice) / nearest.price) * 100
      if (distPct >= 0 && distPct <= 1) {
        proximityScore = 12
        proximityDetail = `at resistance $${nearest.price.toFixed(2)} (${distPct.toFixed(1)}%)`
      } else if (distPct >= 0 && distPct <= 2) {
        proximityScore = 8
        proximityDetail = `near resistance $${nearest.price.toFixed(2)} (${distPct.toFixed(1)}%)`
      }
    }
  }

  // Break of Structure (0-8)
  let bosScore = 0
  let bosDetail = 'no BOS'

  if (direction === 'long') {
    const swingHighs = findSwingHighs(hSlice, rSlice, vSlice, swingWindow)
    if (swingHighs.length > 0) {
      const recentHigh = swingHighs[swingHighs.length - 1]
      const age = len - 1 - recentHigh.index
      const breakPct = ((currentPrice - recentHigh.price) / recentHigh.price) * 100

      if (breakPct > 0 && age <= 30) {
        bosScore = 8
        bosDetail = `BOS above $${recentHigh.price.toFixed(2)} (+${breakPct.toFixed(1)}%, ${age} bars ago)`
      } else if (breakPct > -0.5 && breakPct <= 0) {
        bosScore = 4
        bosDetail = `approaching swing high $${recentHigh.price.toFixed(2)} (${breakPct.toFixed(1)}%)`
      }
    }
  } else {
    const swingLows = findSwingLows(lSlice, rSlice, vSlice, swingWindow)
    if (swingLows.length > 0) {
      const recentLow = swingLows[swingLows.length - 1]
      const age = len - 1 - recentLow.index
      const breakPct = ((recentLow.price - currentPrice) / recentLow.price) * 100

      if (breakPct > 0 && age <= 30) {
        bosScore = 8
        bosDetail = `BOS below $${recentLow.price.toFixed(2)} (-${breakPct.toFixed(1)}%, ${age} bars ago)`
      } else if (breakPct > -0.5 && breakPct <= 0) {
        bosScore = 4
        bosDetail = `approaching swing low $${recentLow.price.toFixed(2)} (${breakPct.toFixed(1)}%)`
      }
    }
  }

  const score = proximityScore + bosScore
  const detail = `${proximityDetail} (${proximityScore}/12), ${bosDetail} (${bosScore}/8)`
  return { score, max: 20, detail }
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
    if (volRatio > 1.5) { score = 15; detail = `${volRatio.toFixed(1)}x avg (strong trend confirm)` }
    else if (volRatio > 1.2) { score = 10; detail = `${volRatio.toFixed(1)}x avg (confirm)` }
    else if (volRatio >= 0.8) { score = 5; detail = `${volRatio.toFixed(1)}x avg (normal)` }
    else { score = 2; detail = `${volRatio.toFixed(1)}x avg (weak)` }
  } else {
    // Ranging mode: low volume = exhaustion (mean-reversion)
    if (volRatio < 0.7) { score = 12; detail = `${volRatio.toFixed(1)}x avg (exhaustion)` }
    else if (volRatio < 0.9) { score = 8; detail = `${volRatio.toFixed(1)}x avg (low)` }
    else if (volRatio <= 1.3) { score = 5; detail = `${volRatio.toFixed(1)}x avg (normal)` }
    else { score = 2; detail = `${volRatio.toFixed(1)}x avg (too high for ranging)` }
  }

  return { score, max: 15, detail }
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
  return { score, max: 10, detail }
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

  return { score, max: 10, detail }
}

// ==================== Main Scorer ====================

export async function scoreSetup(
  symbol: string,
  direction: SignalDirection,
  regime: MarketRegime,
  bars15m: MarketData[],
  bars1h: MarketData[],
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

  const closes = bars15m.map(b => b.close)
  const highs = bars15m.map(b => b.high)
  const lows = bars15m.map(b => b.low)
  const volumes = bars15m.map(b => b.volume)

  const rsiArr = rsiSeries(closes, RSI_PERIOD)

  const trend = scoreTrend(direction, regime, bars1h)
  const momentum = scoreMomentum(direction, closes, RSI_PERIOD)
  const structure = scoreStructure(direction, closes, highs, lows, rsiArr, volumes, SWING_WINDOW)
  const volume = scoreVolume(regime.regime, volumes, VOL_AVG_PERIOD)
  const volatility = scoreVolatility(closes, BB_PERIOD, BB_MULT, BBWP_LOOKBACK)
  const fundingScore = scoreFunding(direction, funding)

  const totalScore = trend.score + momentum.score + structure.score
    + volume.score + volatility.score + fundingScore.score

  return {
    symbol,
    direction,
    totalScore,
    regime: regime.regime,
    dimensions: {
      trend,
      momentum,
      structure,
      volume,
      volatility,
      funding: fundingScore,
    },
    entry: null, // filled by entry-trigger.ts if score qualifies
  }
}
