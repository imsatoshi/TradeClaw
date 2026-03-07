/**
 * 1H entry trigger — precise entry conditions with structure-based SL/TP.
 *
 * Improvements over v1 (ATR-only):
 * - TP targets use swing highs/lows and liquidity zones when available
 * - SL multiplier adapts to per-symbol volatility (ATR/price ratio)
 * - Pending entry zones generated when setup qualifies but no immediate trigger
 */

import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import type { EntryTrigger, SignalDirection, PendingZone } from './types.js'
import {
  findSwingHighs, findSwingLows, rsiSeries, atrSeries,
  detectLiquidityZones, findStructuralLevels,
} from './helpers.js'

// ==================== Dynamic SL Multiplier ====================

/**
 * Compute SL multiplier based on volatility profile.
 * High-volatility coins need wider stops to avoid noise wicks.
 */
function dynamicSlMultiplier(atr: number, price: number): number {
  const volRatio = (atr / price) * 100 // ATR as % of price
  if (volRatio > 3.0) return 2.5       // extreme vol (meme coins)
  if (volRatio > 2.0) return 2.0       // high vol
  if (volRatio > 1.0) return 1.5       // normal
  return 1.2                           // low vol (BTC, stables)
}

// ==================== Structure-Based TP ====================

/**
 * Find TP targets using structural levels. Falls back to ATR multiples
 * if insufficient structure is found.
 *
 * For LONG: resistances above entry become TP targets
 * For SHORT: supports below entry become TP targets
 */
function computeStructureTPs(
  direction: SignalDirection,
  entry: number,
  atr: number,
  resistances: number[],
  supports: number[],
): { tps: [number, number, number]; source: 'structure' | 'atr' } {
  const targets = direction === 'long' ? resistances : supports
  // For short, supports are descending (nearest first), so lower prices
  const validTargets = direction === 'long'
    ? targets.filter(t => t > entry + 0.5 * atr).slice(0, 5) // ascending, skip too close
    : targets.filter(t => t < entry - 0.5 * atr).slice(0, 5) // descending, skip too close

  // ATR fallback values
  const sign = direction === 'long' ? 1 : -1
  const atrTp1 = entry + sign * 1.5 * atr
  const atrTp2 = entry + sign * 3.0 * atr
  const atrTp3 = entry + sign * 4.5 * atr

  if (validTargets.length === 0) {
    return { tps: [atrTp1, atrTp2, atrTp3], source: 'atr' }
  }

  // Map structural levels to TP slots
  let tp1: number, tp2: number, tp3: number

  if (validTargets.length >= 3) {
    tp1 = validTargets[0]
    tp2 = validTargets[1]
    tp3 = validTargets[2]
  } else if (validTargets.length === 2) {
    tp1 = validTargets[0]
    tp2 = validTargets[1]
    tp3 = atrTp3 // extend with ATR for trailing
  } else {
    // 1 structural target
    tp1 = validTargets[0]
    tp2 = atrTp2
    tp3 = atrTp3
  }

  // Sanity: ensure TPs are monotonically away from entry
  if (direction === 'long') {
    tp2 = Math.max(tp2, tp1 + 0.3 * atr)
    tp3 = Math.max(tp3, tp2 + 0.3 * atr)
  } else {
    tp2 = Math.min(tp2, tp1 - 0.3 * atr)
    tp3 = Math.min(tp3, tp2 - 0.3 * atr)
  }

  return { tps: [tp1, tp2, tp3], source: 'structure' }
}

// ==================== Main Entry Trigger ====================

/**
 * Check if 1H price action provides a valid entry trigger.
 *
 * @returns EntryTrigger if conditions met, null otherwise
 */
export function checkEntryTrigger(
  direction: SignalDirection,
  bars: MarketData[],
  atr: number,
): EntryTrigger | null {
  if (bars.length < 30 || atr <= 0) return null

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const volumes = bars.map(b => b.volume)

  const current = bars[bars.length - 1]
  const prev = bars[bars.length - 2]
  const entry = current.close

  // Volume context for trigger confirmation
  const avgVol20 = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
  const currentVol = current.volume

  // RSI for swing detection
  const rsiArr = rsiSeries(closes, 14)
  if (rsiArr.length < 10) return null

  const offset = closes.length - rsiArr.length
  const len = rsiArr.length
  const aCloses = closes.slice(offset, offset + len)
  const aHighs = highs.slice(offset, offset + len)
  const aLows = lows.slice(offset, offset + len)
  const aVols = volumes.slice(offset, offset + len)

  // Minimum body filter — reject doji/noise candles
  const minBody = 0.3 * atr
  const currentBody = Math.abs(current.close - current.open)
  if (currentBody < minBody) return null

  // Detect structural context
  const swingHighs = findSwingHighs(aHighs, rsiArr, aVols, 3)
  const swingLows = findSwingLows(aLows, rsiArr, aVols, 3)
  const liquidityZones = detectLiquidityZones(swingHighs, swingLows)
  const { resistances, supports } = findStructuralLevels(swingHighs, swingLows, entry, liquidityZones)

  let triggered = false
  let reason = ''

  if (direction === 'long') {
    // Trigger 1: Bullish confirmation — current close > previous high + break margin + volume above average
    const breakMargin = 0.15 * atr
    if (current.close > prev.high + breakMargin && currentVol > avgVol20) {
      triggered = true
      reason = `bullish confirm: close $${current.close.toFixed(4)} > prev high $${prev.high.toFixed(4)} +margin, vol ${(currentVol / avgVol20).toFixed(1)}x`
    }

    // Trigger 2: Support bounce — at swing low + bullish candle with meaningful lower wick
    if (!triggered) {
      if (swingLows.length > 0) {
        const nearest = swingLows[swingLows.length - 1]
        const distPct = ((entry - nearest.price) / nearest.price) * 100
        const body = Math.abs(current.close - current.open)
        const lowerWick = Math.min(current.close, current.open) - current.low
        const hasWick = body > 0 ? lowerWick >= body * 0.5 : lowerWick > 0
        if (distPct >= 0 && distPct <= 1.0 && current.close > current.open && hasWick) {
          triggered = true
          reason = `support bounce: at swing low $${nearest.price.toFixed(4)} (${distPct.toFixed(1)}%), wick rejection`
        }
      }
    }

    // Trigger 3: BOS pullback — broke swing high then pulled back near it
    if (!triggered) {
      if (swingHighs.length > 0) {
        const recentHigh = swingHighs[swingHighs.length - 1]
        const age = len - 1 - recentHigh.index
        const distPct = ((entry - recentHigh.price) / recentHigh.price) * 100
        if (age <= 12 && distPct >= -0.3 && distPct <= 1.0 && current.close > current.open) {
          triggered = true
          reason = `BOS pullback: retesting swing high $${recentHigh.price.toFixed(2)} (${distPct.toFixed(1)}%, ${age} bars ago)`
        }
      }
    }

    // Trigger 4: Liquidity sweep — price wicked below equal lows then closed above
    if (!triggered) {
      const eqLows = liquidityZones.filter(lz => lz.type === 'equal_lows')
      for (const lz of eqLows) {
        const sweptBelow = current.low < lz.price * 0.998
        const closedAbove = current.close > lz.price * 1.001
        if (sweptBelow && closedAbove && current.close > current.open) {
          triggered = true
          reason = `liquidity sweep: wicked below EQL $${lz.price.toFixed(4)} (${lz.count} touches), reclaimed`
          break
        }
      }
    }

    if (!triggered) return null

    // Dynamic SL
    const slMult = dynamicSlMultiplier(atr, entry)
    let sl = entry - slMult * atr

    // Improve SL using structure — place below nearest support
    if (supports.length > 0) {
      const nearestSupport = supports[0] // descending, nearest first
      const structureSl = nearestSupport - 0.1 * atr
      // Use structure SL if it's tighter than ATR SL but not too tight
      if (structureSl > sl && structureSl < entry - 0.5 * atr) {
        sl = structureSl
      }
    }

    // Enforce minimum SL distance of 0.5×ATR
    const minSlDist = 0.5 * atr
    if (entry - sl < minSlDist) sl = entry - minSlDist

    // Structure-based TP
    const { tps, source: tpSource } = computeStructureTPs(direction, entry, atr, resistances, supports)
    const [tp1, tp2, tp3] = tps

    const slDist = entry - sl
    if (slDist <= 0) return null

    const weightedTP = tp1 * 0.4 + tp2 * 0.3 + tp3 * 0.3
    const rr = Math.min((weightedTP - entry) / slDist, 5.0)

    if (rr < 1.8) return null

    return {
      triggered: true,
      entry: round(entry),
      stopLoss: round(sl),
      takeProfits: {
        tp1: { price: round(tp1), ratio: 0.4 },
        tp2: { price: round(tp2), ratio: 0.3 },
        tp3: { price: round(tp3), ratio: 0.3 },
      },
      riskReward: round(rr),
      reason,
      tpSource,
      slSource: supports.length > 0 ? 'structure' : 'dynamic',
    }
  } else {
    // SHORT triggers

    // Trigger 1: Bearish confirmation
    const breakMargin = 0.15 * atr
    if (current.close < prev.low - breakMargin && currentVol > avgVol20) {
      triggered = true
      reason = `bearish confirm: close $${current.close.toFixed(4)} < prev low $${prev.low.toFixed(4)} -margin, vol ${(currentVol / avgVol20).toFixed(1)}x`
    }

    // Trigger 2: Resistance rejection
    if (!triggered) {
      if (swingHighs.length > 0) {
        const nearest = swingHighs[swingHighs.length - 1]
        const distPct = ((nearest.price - entry) / nearest.price) * 100
        const body = Math.abs(current.close - current.open)
        const upperWick = current.high - Math.max(current.close, current.open)
        const hasWick = body > 0 ? upperWick >= body * 0.5 : upperWick > 0
        if (distPct >= 0 && distPct <= 1.0 && current.close < current.open && hasWick) {
          triggered = true
          reason = `resistance reject: at swing high $${nearest.price.toFixed(4)} (${distPct.toFixed(1)}%), wick rejection`
        }
      }
    }

    // Trigger 3: BOS pullback
    if (!triggered) {
      if (swingLows.length > 0) {
        const recentLow = swingLows[swingLows.length - 1]
        const age = len - 1 - recentLow.index
        const distPct = ((recentLow.price - entry) / recentLow.price) * 100
        if (age <= 12 && distPct >= -0.3 && distPct <= 1.0 && current.close < current.open) {
          triggered = true
          reason = `BOS pullback: retesting swing low $${recentLow.price.toFixed(2)} (${distPct.toFixed(1)}%, ${age} bars ago)`
        }
      }
    }

    // Trigger 4: Liquidity sweep — price wicked above equal highs then closed below
    if (!triggered) {
      const eqHighs = liquidityZones.filter(lz => lz.type === 'equal_highs')
      for (const lz of eqHighs) {
        const sweptAbove = current.high > lz.price * 1.002
        const closedBelow = current.close < lz.price * 0.999
        if (sweptAbove && closedBelow && current.close < current.open) {
          triggered = true
          reason = `liquidity sweep: wicked above EQH $${lz.price.toFixed(4)} (${lz.count} touches), rejected`
          break
        }
      }
    }

    if (!triggered) return null

    // Dynamic SL
    const slMult = dynamicSlMultiplier(atr, entry)
    let sl = entry + slMult * atr

    // Improve SL using structure — place above nearest resistance
    if (resistances.length > 0) {
      const nearestResistance = resistances[0] // ascending, nearest first
      const structureSl = nearestResistance + 0.1 * atr
      if (structureSl < sl && structureSl > entry + 0.5 * atr) {
        sl = structureSl
      }
    }

    // Enforce minimum SL distance
    const minSlDist = 0.5 * atr
    if (sl - entry < minSlDist) sl = entry + minSlDist

    // Structure-based TP
    const { tps, source: tpSource } = computeStructureTPs(direction, entry, atr, resistances, supports)
    const [tp1, tp2, tp3] = tps

    const slDist = sl - entry
    if (slDist <= 0) return null

    const weightedTP = tp1 * 0.4 + tp2 * 0.3 + tp3 * 0.3
    const rr = Math.min((entry - weightedTP) / slDist, 5.0)

    if (rr < 1.8) return null

    return {
      triggered: true,
      entry: round(entry),
      stopLoss: round(sl),
      takeProfits: {
        tp1: { price: round(tp1), ratio: 0.4 },
        tp2: { price: round(tp2), ratio: 0.3 },
        tp3: { price: round(tp3), ratio: 0.3 },
      },
      riskReward: round(rr),
      reason,
      tpSource,
      slSource: resistances.length > 0 ? 'structure' : 'dynamic',
    }
  }
}

// ==================== Pending Entry Zone ====================

/**
 * Generate a pending entry zone when setup qualifies but no immediate trigger fires.
 * The zone represents an ideal pullback area where price should be watched.
 *
 * For LONG: zone is at nearest support / FVG below current price
 * For SHORT: zone is at nearest resistance / FVG above current price
 */
export function computePendingZone(
  symbol: string,
  direction: SignalDirection,
  setupScore: number,
  bars: MarketData[],
  atr: number,
  ttlMs: number = 4 * 60 * 60 * 1000, // 4 hours default
): PendingZone | null {
  if (bars.length < 30 || atr <= 0) return null

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const volumes = bars.map(b => b.volume)
  const currentPrice = closes[closes.length - 1]

  const rsiArr = rsiSeries(closes, 14)
  if (rsiArr.length < 10) return null

  const offset = closes.length - rsiArr.length
  const len = rsiArr.length
  const aHighs = highs.slice(offset, offset + len)
  const aLows = lows.slice(offset, offset + len)
  const aVols = volumes.slice(offset, offset + len)

  const swingHighs = findSwingHighs(aHighs, rsiArr, aVols, 3)
  const swingLows = findSwingLows(aLows, rsiArr, aVols, 3)
  const liquidityZones = detectLiquidityZones(swingHighs, swingLows)
  const { resistances, supports } = findStructuralLevels(swingHighs, swingLows, currentPrice, liquidityZones)

  const slMult = dynamicSlMultiplier(atr, currentPrice)
  const now = Date.now()

  if (direction === 'long') {
    // Ideal entry zone: nearest support below current price
    if (supports.length === 0) return null
    const targetLevel = supports[0] // nearest support (descending)
    const distPct = ((currentPrice - targetLevel) / currentPrice) * 100
    // Only create zone if support is within reasonable distance (0.3% to 3%)
    if (distPct < 0.3 || distPct > 3.0) return null

    const idealEntry = targetLevel
    const zoneHigh = targetLevel + 0.15 * atr
    const zoneLow = targetLevel - 0.3 * atr
    const sl = zoneLow - slMult * 0.5 * atr // tighter SL since we're entering at structure

    const { tps } = computeStructureTPs(direction, idealEntry, atr, resistances, supports)
    const slDist = idealEntry - sl
    if (slDist <= 0) return null
    const weightedTP = tps[0] * 0.4 + tps[1] * 0.3 + tps[2] * 0.3
    const rr = Math.min((weightedTP - idealEntry) / slDist, 5.0)
    if (rr < 2.0) return null // higher bar for pending zones

    return {
      symbol,
      direction,
      setupScore,
      idealEntry: round(idealEntry),
      zoneHigh: round(zoneHigh),
      zoneLow: round(zoneLow),
      stopLoss: round(sl),
      takeProfits: {
        tp1: { price: round(tps[0]), ratio: 0.4 },
        tp2: { price: round(tps[1]), ratio: 0.3 },
        tp3: { price: round(tps[2]), ratio: 0.3 },
      },
      riskReward: round(rr),
      reason: `pullback zone at support $${targetLevel.toFixed(4)} (${distPct.toFixed(1)}% below)`,
      createdAt: now,
      expiresAt: now + ttlMs,
    }
  } else {
    // SHORT: ideal entry zone at nearest resistance above current price
    if (resistances.length === 0) return null
    const targetLevel = resistances[0] // nearest resistance (ascending)
    const distPct = ((targetLevel - currentPrice) / currentPrice) * 100
    if (distPct < 0.3 || distPct > 3.0) return null

    const idealEntry = targetLevel
    const zoneLow = targetLevel - 0.15 * atr
    const zoneHigh = targetLevel + 0.3 * atr
    const sl = zoneHigh + slMult * 0.5 * atr

    const { tps } = computeStructureTPs(direction, idealEntry, atr, resistances, supports)
    const slDist = sl - idealEntry
    if (slDist <= 0) return null
    const weightedTP = tps[0] * 0.4 + tps[1] * 0.3 + tps[2] * 0.3
    const rr = Math.min((idealEntry - weightedTP) / slDist, 5.0)
    if (rr < 2.0) return null

    return {
      symbol,
      direction,
      setupScore,
      idealEntry: round(idealEntry),
      zoneHigh: round(zoneHigh),
      zoneLow: round(zoneLow),
      stopLoss: round(sl),
      takeProfits: {
        tp1: { price: round(tps[0]), ratio: 0.4 },
        tp2: { price: round(tps[1]), ratio: 0.3 },
        tp3: { price: round(tps[2]), ratio: 0.3 },
      },
      riskReward: round(rr),
      reason: `pullback zone at resistance $${targetLevel.toFixed(4)} (${distPct.toFixed(1)}% above)`,
      createdAt: now,
      expiresAt: now + ttlMs,
    }
  }
}

/**
 * Check if current price has entered a pending zone.
 * Returns an EntryTrigger if price is inside the zone.
 */
export function checkPendingZone(
  zone: PendingZone,
  currentPrice: number,
  currentBar: MarketData,
): EntryTrigger | null {
  if (Date.now() > zone.expiresAt) return null

  const inZone = currentPrice >= zone.zoneLow && currentPrice <= zone.zoneHigh

  if (!inZone) return null

  // Confirm with candle direction
  const isBullish = currentBar.close > currentBar.open
  if (zone.direction === 'long' && !isBullish) return null
  if (zone.direction === 'short' && isBullish) return null

  return {
    triggered: true,
    entry: round(currentPrice),
    stopLoss: zone.stopLoss,
    takeProfits: zone.takeProfits,
    riskReward: zone.riskReward,
    reason: `pending zone triggered: ${zone.reason}`,
    tpSource: 'structure',
    slSource: 'structure',
  }
}

/** Adaptive precision: high-price coins get 2dp, low-price coins get up to 6dp. */
function round(v: number): number {
  const abs = Math.abs(v)
  if (abs >= 100) return Math.round(v * 100) / 100       // 2 dp ($95200.12)
  if (abs >= 1)   return Math.round(v * 10000) / 10000    // 4 dp ($0.1423)
  return Math.round(v * 1000000) / 1000000                // 6 dp ($0.000142)
}
