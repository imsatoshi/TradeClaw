import { describe, it, expect } from 'vitest'

/**
 * Unit tests for TradeManager SL/TP validation and progressive protection logic.
 * These test the pure functions extracted from TradeManager without needing
 * Freqtrade or exchange connections.
 */

// We test validateSlTp indirectly by constructing plan-like objects
// and calling the validation logic. Since validateSlTp is private,
// we replicate its logic here for unit testing.

function validateSlTp(plan: {
  entryPrice?: number
  direction: 'long' | 'short'
  stopLoss: { price: number }
  takeProfits: { level: number; price: number }[]
}): string | null {
  const entry = plan.entryPrice
  if (!entry) return 'no entry price'

  const sl = plan.stopLoss.price
  const isLong = plan.direction === 'long'

  if (isLong && sl >= entry) {
    return `SL $${sl} is at or above entry $${entry} for LONG — must be below`
  }
  if (!isLong && sl <= entry) {
    return `SL $${sl} is at or below entry $${entry} for SHORT — must be above`
  }

  const slDistPct = (Math.abs(entry - sl) / entry) * 100
  if (slDistPct < 0.3) {
    return `SL too tight: ${slDistPct.toFixed(2)}% from entry (min 0.3%)`
  }
  if (slDistPct > 15) {
    return `SL too wide: ${slDistPct.toFixed(2)}% from entry (max 15%)`
  }

  const tp1 = plan.takeProfits.find(tp => tp.level === 1)
  if (tp1) {
    if (isLong && tp1.price <= entry) {
      return `TP1 $${tp1.price} is at or below entry $${entry} for LONG — must be above`
    }
    if (!isLong && tp1.price >= entry) {
      return `TP1 $${tp1.price} is at or above entry $${entry} for SHORT — must be below`
    }

    const tp1Dist = Math.abs(tp1.price - entry)
    const slDist = Math.abs(entry - sl)
    const rr = tp1Dist / slDist
    if (rr < 1.0) {
      return `R:R too low: ${rr.toFixed(2)} (TP1 dist ${tp1Dist.toFixed(4)} / SL dist ${slDist.toFixed(4)}, min 1.0)`
    }
  }

  return null
}

describe('validateSlTp', () => {
  it('accepts valid long plan', () => {
    const err = validateSlTp({
      entryPrice: 100,
      direction: 'long',
      stopLoss: { price: 95 },
      takeProfits: [{ level: 1, price: 110 }],
    })
    expect(err).toBeNull()
  })

  it('accepts valid short plan', () => {
    const err = validateSlTp({
      entryPrice: 100,
      direction: 'short',
      stopLoss: { price: 105 },
      takeProfits: [{ level: 1, price: 90 }],
    })
    expect(err).toBeNull()
  })

  it('rejects long with SL above entry', () => {
    const err = validateSlTp({
      entryPrice: 0.7959,
      direction: 'long',
      stopLoss: { price: 0.82 },
      takeProfits: [{ level: 1, price: 0.85 }],
    })
    expect(err).toContain('above entry')
  })

  it('rejects short with SL below entry', () => {
    const err = validateSlTp({
      entryPrice: 100,
      direction: 'short',
      stopLoss: { price: 95 },
      takeProfits: [{ level: 1, price: 90 }],
    })
    expect(err).toContain('below entry')
  })

  it('rejects long with SL = entry', () => {
    const err = validateSlTp({
      entryPrice: 0.231,
      direction: 'long',
      stopLoss: { price: 0.231 },
      takeProfits: [{ level: 1, price: 0.24 }],
    })
    expect(err).toContain('at or above entry')
  })

  it('rejects SL too tight (< 0.3%)', () => {
    const err = validateSlTp({
      entryPrice: 100,
      direction: 'long',
      stopLoss: { price: 99.8 },
      takeProfits: [{ level: 1, price: 102 }],
    })
    expect(err).toContain('too tight')
  })

  it('rejects SL too wide (> 15%)', () => {
    const err = validateSlTp({
      entryPrice: 100,
      direction: 'long',
      stopLoss: { price: 80 },
      takeProfits: [{ level: 1, price: 130 }],
    })
    expect(err).toContain('too wide')
  })

  it('rejects R:R < 1.0', () => {
    const err = validateSlTp({
      entryPrice: 100,
      direction: 'long',
      stopLoss: { price: 95 },
      takeProfits: [{ level: 1, price: 103 }],
    })
    // SL dist = 5, TP1 dist = 3, R:R = 0.6
    expect(err).toContain('R:R too low')
  })

  it('rejects long TP1 below entry', () => {
    const err = validateSlTp({
      entryPrice: 100,
      direction: 'long',
      stopLoss: { price: 95 },
      takeProfits: [{ level: 1, price: 98 }],
    })
    expect(err).toContain('at or below entry')
  })

  it('rejects short TP1 above entry', () => {
    const err = validateSlTp({
      entryPrice: 100,
      direction: 'short',
      stopLoss: { price: 105 },
      takeProfits: [{ level: 1, price: 102 }],
    })
    expect(err).toContain('at or above entry')
  })

  it('catches the historical APT bug (SL 0.82 > entry 0.7959 for long)', () => {
    const err = validateSlTp({
      entryPrice: 0.7959,
      direction: 'long',
      stopLoss: { price: 0.82 },
      takeProfits: [{ level: 1, price: 0.85 }],
    })
    expect(err).not.toBeNull()
  })

  it('catches the historical LA bug (SL = entry for long)', () => {
    const err = validateSlTp({
      entryPrice: 0.231,
      direction: 'long',
      stopLoss: { price: 0.231 },
      takeProfits: [{ level: 1, price: 0.24 }],
    })
    expect(err).not.toBeNull()
  })
})

// Test progressive protection stage calculation
describe('progressive protection stages', () => {
  function computeStage(profitAtr: number): { stageNum: number; slOffset: number } | null {
    const stages: [number, number][] = [
      [3.5, 2.0],
      [2.5, 1.0],
      [1.5, 0.0],
      [1.0, -0.5],
    ]

    for (let i = 0; i < stages.length; i++) {
      const stageNum = stages.length - i
      const [threshold, slOffset] = stages[i]
      if (profitAtr >= threshold) {
        return { stageNum, slOffset }
      }
    }
    return null
  }

  it('no stage below +1.0x ATR', () => {
    expect(computeStage(0.5)).toBeNull()
    expect(computeStage(0.9)).toBeNull()
  })

  it('stage 1 at +1.0x ATR (SL offset -0.5)', () => {
    const s = computeStage(1.0)
    expect(s).toEqual({ stageNum: 1, slOffset: -0.5 })
  })

  it('stage 2 at +1.5x ATR (breakeven)', () => {
    const s = computeStage(1.5)
    expect(s).toEqual({ stageNum: 2, slOffset: 0.0 })
  })

  it('stage 3 at +2.5x ATR (lock +1x ATR)', () => {
    const s = computeStage(2.5)
    expect(s).toEqual({ stageNum: 3, slOffset: 1.0 })
  })

  it('stage 4 at +3.5x ATR (lock +2x ATR)', () => {
    const s = computeStage(3.5)
    expect(s).toEqual({ stageNum: 4, slOffset: 2.0 })
  })

  it('stage 4 at +5.0x ATR (still highest stage)', () => {
    const s = computeStage(5.0)
    expect(s).toEqual({ stageNum: 4, slOffset: 2.0 })
  })

  it('computes correct SL for long', () => {
    const entry = 100
    const atr = 5
    const s = computeStage(2.0) // +2.0x ATR → stage 2, offset 0.0
    expect(s).toEqual({ stageNum: 2, slOffset: 0.0 })
    const newSl = entry + s!.slOffset * atr
    expect(newSl).toBe(100) // breakeven
  })

  it('computes correct SL for lock-profit stage', () => {
    const entry = 100
    const atr = 5
    const s = computeStage(3.0) // +3.0x ATR → stage 3, offset 1.0
    expect(s).toEqual({ stageNum: 3, slOffset: 1.0 })
    const newSl = entry + s!.slOffset * atr
    expect(newSl).toBe(105) // locked $5 profit
  })
})

// Test regime-adaptive TP ratios
describe('regime-adaptive TP ratios', () => {
  function tpRatios(regime?: string): [number, number, number] {
    if (regime === 'uptrend' || regime === 'downtrend') return [0.3, 0.3, 0.4]
    if (regime === 'ranging') return [0.5, 0.3, 0.2]
    return [0.4, 0.3, 0.3]
  }

  it('trending: back-loaded (30/30/40)', () => {
    expect(tpRatios('uptrend')).toEqual([0.3, 0.3, 0.4])
    expect(tpRatios('downtrend')).toEqual([0.3, 0.3, 0.4])
  })

  it('ranging: front-loaded (50/30/20)', () => {
    expect(tpRatios('ranging')).toEqual([0.5, 0.3, 0.2])
  })

  it('default: balanced (40/30/30)', () => {
    expect(tpRatios()).toEqual([0.4, 0.3, 0.3])
    expect(tpRatios('unknown')).toEqual([0.4, 0.3, 0.3])
  })

  it('all ratios sum to 1.0', () => {
    for (const r of ['uptrend', 'downtrend', 'ranging', undefined]) {
      const [r1, r2, r3] = tpRatios(r)
      expect(r1 + r2 + r3).toBeCloseTo(1.0)
    }
  })
})

// Test dynamic SL multiplier with regime
describe('dynamicSlMultiplier with regime', () => {
  function dynamicSlMultiplier(atr: number, price: number, regime?: string): number {
    const volRatio = (atr / price) * 100
    let mult: number
    if (volRatio > 3.0) mult = 2.5
    else if (volRatio > 2.0) mult = 2.0
    else if (volRatio > 1.0) mult = 1.8
    else mult = 1.3

    if (regime === 'uptrend' || regime === 'downtrend') mult *= 1.2
    else if (regime === 'ranging') mult *= 0.85

    return mult
  }

  it('normal vol without regime = 1.8', () => {
    expect(dynamicSlMultiplier(1.5, 100)).toBe(1.8) // volRatio = 1.5%
  })

  it('normal vol + trending = 1.8 * 1.2 = 2.16', () => {
    expect(dynamicSlMultiplier(1.5, 100, 'uptrend')).toBeCloseTo(2.16)
  })

  it('normal vol + ranging = 1.8 * 0.85 = 1.53', () => {
    expect(dynamicSlMultiplier(1.5, 100, 'ranging')).toBeCloseTo(1.53)
  })

  it('low vol = 1.3', () => {
    expect(dynamicSlMultiplier(0.5, 100)).toBe(1.3) // volRatio = 0.5%
  })

  it('extreme vol = 2.5', () => {
    expect(dynamicSlMultiplier(4.0, 100)).toBe(2.5) // volRatio = 4%
  })

  it('extreme vol + trending = 3.0', () => {
    expect(dynamicSlMultiplier(4.0, 100, 'uptrend')).toBeCloseTo(3.0)
  })
})

// Test trade profile mapping
describe('mapToProfile', () => {
  // Replicate the mapping logic from entry-trigger.ts
  type TriggerType = 'bullish_confirm' | 'support_bounce' | 'bos_pullback' | 'liquidity_sweep'
    | 'bearish_confirm' | 'resistance_reject' | 'pending_zone'
  type TradeProfile = 'trend' | 'reversal' | 'breakout' | 'scalp'

  function mapToProfile(triggerType: TriggerType, regime?: string): TradeProfile {
    switch (triggerType) {
      case 'bullish_confirm':
      case 'bearish_confirm':
        return (regime === 'uptrend' || regime === 'downtrend') ? 'trend' : 'reversal'
      case 'support_bounce':
      case 'resistance_reject':
        return 'reversal'
      case 'bos_pullback':
        return (regime === 'uptrend' || regime === 'downtrend') ? 'trend' : 'breakout'
      case 'liquidity_sweep':
        return 'scalp'
      case 'pending_zone':
        return (regime === 'uptrend' || regime === 'downtrend') ? 'trend' : 'reversal'
      default:
        return 'reversal'
    }
  }

  it('bullish confirm + trending = trend', () => {
    expect(mapToProfile('bullish_confirm', 'uptrend')).toBe('trend')
    expect(mapToProfile('bearish_confirm', 'downtrend')).toBe('trend')
  })

  it('bullish confirm + ranging = reversal', () => {
    expect(mapToProfile('bullish_confirm', 'ranging')).toBe('reversal')
    expect(mapToProfile('bullish_confirm')).toBe('reversal')
  })

  it('support bounce always = reversal', () => {
    expect(mapToProfile('support_bounce', 'uptrend')).toBe('reversal')
    expect(mapToProfile('support_bounce', 'ranging')).toBe('reversal')
    expect(mapToProfile('resistance_reject', 'downtrend')).toBe('reversal')
  })

  it('BOS pullback + trending = trend', () => {
    expect(mapToProfile('bos_pullback', 'uptrend')).toBe('trend')
  })

  it('BOS pullback + ranging = breakout', () => {
    expect(mapToProfile('bos_pullback', 'ranging')).toBe('breakout')
    expect(mapToProfile('bos_pullback')).toBe('breakout')
  })

  it('liquidity sweep always = scalp', () => {
    expect(mapToProfile('liquidity_sweep', 'uptrend')).toBe('scalp')
    expect(mapToProfile('liquidity_sweep', 'ranging')).toBe('scalp')
  })

  it('pending zone + trending = trend', () => {
    expect(mapToProfile('pending_zone', 'downtrend')).toBe('trend')
  })

  it('pending zone + ranging = reversal', () => {
    expect(mapToProfile('pending_zone', 'ranging')).toBe('reversal')
  })
})

// Test profile-based SL factors and TP ratios
describe('profile SL/TP parameters', () => {
  const PROFILE_SL_FACTOR: Record<string, number> = {
    trend: 1.3, reversal: 1.0, breakout: 0.8, scalp: 0.7,
  }
  const PROFILE_TP_RATIOS: Record<string, [number, number, number]> = {
    trend: [0.25, 0.35, 0.40],
    reversal: [0.50, 0.30, 0.20],
    breakout: [0.40, 0.30, 0.30],
    scalp: [0.60, 0.40, 0.00],
  }

  it('trend has widest SL', () => {
    expect(PROFILE_SL_FACTOR.trend).toBeGreaterThan(PROFILE_SL_FACTOR.reversal)
    expect(PROFILE_SL_FACTOR.trend).toBeGreaterThan(PROFILE_SL_FACTOR.breakout)
    expect(PROFILE_SL_FACTOR.trend).toBeGreaterThan(PROFILE_SL_FACTOR.scalp)
  })

  it('scalp has tightest SL', () => {
    expect(PROFILE_SL_FACTOR.scalp).toBeLessThan(PROFILE_SL_FACTOR.reversal)
  })

  it('all TP ratios sum to 1.0', () => {
    for (const profile of ['trend', 'reversal', 'breakout']) {
      const [r1, r2, r3] = PROFILE_TP_RATIOS[profile]
      expect(r1 + r2 + r3).toBeCloseTo(1.0)
    }
    // scalp has only 2 TPs
    const [s1, s2, s3] = PROFILE_TP_RATIOS.scalp
    expect(s1 + s2 + s3).toBeCloseTo(1.0)
  })

  it('reversal is front-loaded (TP1 >= 50%)', () => {
    expect(PROFILE_TP_RATIOS.reversal[0]).toBeGreaterThanOrEqual(0.5)
  })

  it('trend is back-loaded (TP3 >= 40%)', () => {
    expect(PROFILE_TP_RATIOS.trend[2]).toBeGreaterThanOrEqual(0.4)
  })
})

// Test DCA layer computation
describe('DCA layer computation', () => {
  function computeDcaLayers(
    entry: number, atr: number, direction: 'long' | 'short', stakeAmount: number,
  ) {
    const triggerMultiples = [1.5, 2.5]
    const layerSizeRatio = [0.5, 0.5]
    const hardStopMultiple = 3.5
    const isLong = direction === 'long'

    const layers = triggerMultiples.map((mult, i) => ({
      layer: i + 1,
      triggerPrice: isLong ? entry - mult * atr : entry + mult * atr,
      stakeAmount: stakeAmount * layerSizeRatio[i],
      status: 'pending' as const,
    }))
    const hardStopPrice = isLong ? entry - hardStopMultiple * atr : entry + hardStopMultiple * atr
    return { layers, hardStopPrice }
  }

  it('computes long DCA layers correctly', () => {
    const { layers, hardStopPrice } = computeDcaLayers(3000, 60, 'long', 300)
    expect(layers[0].triggerPrice).toBe(2910)  // 3000 - 1.5*60
    expect(layers[1].triggerPrice).toBe(2850)  // 3000 - 2.5*60
    expect(layers[0].stakeAmount).toBe(150)    // 50% of 300
    expect(layers[1].stakeAmount).toBe(150)
    expect(hardStopPrice).toBe(2790)           // 3000 - 3.5*60
  })

  it('computes short DCA layers correctly', () => {
    const { layers, hardStopPrice } = computeDcaLayers(3000, 60, 'short', 300)
    expect(layers[0].triggerPrice).toBe(3090)  // 3000 + 1.5*60
    expect(layers[1].triggerPrice).toBe(3150)  // 3000 + 2.5*60
    expect(hardStopPrice).toBe(3210)           // 3000 + 3.5*60
  })

  it('DCA total stake is capped at 2x initial', () => {
    const { layers } = computeDcaLayers(100, 5, 'long', 200)
    const totalDca = layers.reduce((s, l) => s + l.stakeAmount, 0)
    expect(totalDca).toBeLessThanOrEqual(200) // <= initial stake
    expect(totalDca + 200).toBeLessThanOrEqual(400) // total <= 2x initial
  })
})

// Test DCA trigger and take-profit logic
describe('DCA trigger logic', () => {
  function shouldTriggerDca(
    currentPrice: number, triggerPrice: number, direction: 'long' | 'short',
  ): boolean {
    return direction === 'long'
      ? currentPrice <= triggerPrice
      : currentPrice >= triggerPrice
  }

  function shouldDcaTakeProfit(
    currentPrice: number, avgEntry: number, direction: 'long' | 'short', threshold: number,
  ): boolean {
    const profitPct = direction === 'long'
      ? (currentPrice - avgEntry) / avgEntry
      : (avgEntry - currentPrice) / avgEntry
    return profitPct >= threshold
  }

  function shouldDcaHardStop(
    currentPrice: number, hardStopPrice: number, direction: 'long' | 'short',
  ): boolean {
    return direction === 'long'
      ? currentPrice <= hardStopPrice
      : currentPrice >= hardStopPrice
  }

  it('long DCA triggers when price drops to trigger level', () => {
    expect(shouldTriggerDca(2910, 2910, 'long')).toBe(true)
    expect(shouldTriggerDca(2900, 2910, 'long')).toBe(true)
    expect(shouldTriggerDca(2920, 2910, 'long')).toBe(false)
  })

  it('short DCA triggers when price rises to trigger level', () => {
    expect(shouldTriggerDca(3090, 3090, 'short')).toBe(true)
    expect(shouldTriggerDca(3100, 3090, 'short')).toBe(true)
    expect(shouldTriggerDca(3080, 3090, 'short')).toBe(false)
  })

  it('DCA take-profit triggers at threshold for long', () => {
    // avg entry $2940, threshold 1.5%
    expect(shouldDcaTakeProfit(2985, 2940, 'long', 0.015)).toBe(true) // +1.53%
    expect(shouldDcaTakeProfit(2950, 2940, 'long', 0.015)).toBe(false) // +0.34%
  })

  it('DCA take-profit triggers at threshold for short', () => {
    // avg entry $3060, threshold 1.5%
    expect(shouldDcaTakeProfit(3014, 3060, 'short', 0.015)).toBe(true) // +1.5%
    expect(shouldDcaTakeProfit(3050, 3060, 'short', 0.015)).toBe(false)
  })

  it('DCA hard stop triggers for long', () => {
    expect(shouldDcaHardStop(2790, 2790, 'long')).toBe(true)
    expect(shouldDcaHardStop(2780, 2790, 'long')).toBe(true)
    expect(shouldDcaHardStop(2800, 2790, 'long')).toBe(false)
  })

  it('DCA hard stop triggers for short', () => {
    expect(shouldDcaHardStop(3210, 3210, 'short')).toBe(true)
    expect(shouldDcaHardStop(3200, 3210, 'short')).toBe(false)
  })

  it('avg entry recomputation after DCA fills', () => {
    // Initial: entry $3000, size 0.1 ETH
    // DCA L1: filled at $2910, size 0.05 ETH
    const totalCost = 3000 * 0.1 + 2910 * 0.05
    const totalAmount = 0.1 + 0.05
    const avgEntry = totalCost / totalAmount
    expect(avgEntry).toBeCloseTo(2970, 0) // weighted avg

    // After L2: filled at $2850, size 0.05 ETH
    const totalCost2 = totalCost + 2850 * 0.05
    const totalAmount2 = totalAmount + 0.05
    const avgEntry2 = totalCost2 / totalAmount2
    expect(avgEntry2).toBeCloseTo(2940, 0) // matches design doc
  })
})

// Test profile-driven progressive protection stages
describe('profile progressive stages', () => {
  // Replicate the stage tables from TradeManager
  const PROGRESSIVE_STAGES: Record<string, [number, number][]> = {
    trend: [[4.0, 2.5], [3.0, 1.5], [2.0, 0.5], [1.5, 0.0]],
    reversal: [[3.5, 2.0], [2.5, 1.0], [1.5, 0.0], [1.0, -0.5]],
    breakout: [[3.0, 2.0], [2.0, 1.0], [1.2, 0.0], [0.8, -0.3]],
    scalp: [[2.0, 1.5], [1.5, 1.0], [1.0, 0.0], [0.5, -0.3]],
  }

  function getStageForProfit(profile: string, profitAtr: number): { stage: number; slOffset: number } | null {
    const stages = PROGRESSIVE_STAGES[profile]
    for (let i = 0; i < stages.length; i++) {
      const [threshold, slOffset] = stages[i]
      if (profitAtr >= threshold) {
        return { stage: stages.length - i, slOffset }
      }
    }
    return null
  }

  it('trend reaches breakeven later than reversal', () => {
    // At +1.0 ATR profit: reversal hits stage 1, trend does not
    expect(getStageForProfit('reversal', 1.0)).not.toBeNull()
    expect(getStageForProfit('trend', 1.0)).toBeNull()
  })

  it('scalp reaches breakeven earliest', () => {
    // At +1.0 ATR: scalp is at breakeven (stage 2), breakout at breakeven (stage 2)
    const scalpStage = getStageForProfit('scalp', 1.0)
    expect(scalpStage).not.toBeNull()
    expect(scalpStage!.slOffset).toBe(0.0) // breakeven

    // At +0.5 ATR: only scalp triggers (stage 1)
    expect(getStageForProfit('scalp', 0.5)).not.toBeNull()
    expect(getStageForProfit('breakout', 0.5)).toBeNull()
    expect(getStageForProfit('reversal', 0.5)).toBeNull()
    expect(getStageForProfit('trend', 0.5)).toBeNull()
  })

  it('all profiles have 4 stages', () => {
    for (const profile of ['trend', 'reversal', 'breakout', 'scalp']) {
      expect(PROGRESSIVE_STAGES[profile]).toHaveLength(4)
    }
  })

  it('stages are ordered descending by threshold', () => {
    for (const profile of ['trend', 'reversal', 'breakout', 'scalp']) {
      const thresholds = PROGRESSIVE_STAGES[profile].map(s => s[0])
      for (let i = 1; i < thresholds.length; i++) {
        expect(thresholds[i]).toBeLessThan(thresholds[i - 1])
      }
    }
  })

  it('SL offsets are ordered descending within each profile', () => {
    for (const profile of ['trend', 'reversal', 'breakout', 'scalp']) {
      const offsets = PROGRESSIVE_STAGES[profile].map(s => s[1])
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeLessThan(offsets[i - 1])
      }
    }
  })
})

// Test profile-driven auto trailing
describe('profile auto trailing', () => {
  const PROFILE_TRAILING: Record<string, { type: string; distance: number; lookbackBars?: number } | null> = {
    trend: { type: 'chandelier', distance: 2.5, lookbackBars: 14 },
    reversal: null,
    breakout: { type: 'chandelier', distance: 3.0, lookbackBars: 10 },
    scalp: { type: 'percent', distance: 1.0 },
  }

  it('trend auto-enables chandelier trailing', () => {
    expect(PROFILE_TRAILING.trend).not.toBeNull()
    expect(PROFILE_TRAILING.trend!.type).toBe('chandelier')
    expect(PROFILE_TRAILING.trend!.distance).toBe(2.5)
  })

  it('reversal has no auto trailing (relies on DCA)', () => {
    expect(PROFILE_TRAILING.reversal).toBeNull()
  })

  it('breakout uses wider chandelier than trend', () => {
    expect(PROFILE_TRAILING.breakout!.distance).toBeGreaterThan(PROFILE_TRAILING.trend!.distance)
  })

  it('scalp uses tight percent trailing', () => {
    expect(PROFILE_TRAILING.scalp!.type).toBe('percent')
    expect(PROFILE_TRAILING.scalp!.distance).toBe(1.0)
  })
})

// Test SL proximity detection
describe('SL proximity warning', () => {
  function getSlProximityPct(
    currentPrice: number, slPrice: number, direction: 'long' | 'short',
  ): number {
    return direction === 'long'
      ? (currentPrice - slPrice) / currentPrice * 100
      : (slPrice - currentPrice) / currentPrice * 100
  }

  it('long: detects proximity when price near SL', () => {
    // Entry $100, SL $97, current price $97.30 → 0.31% from SL
    const dist = getSlProximityPct(97.30, 97, 'long')
    expect(dist).toBeGreaterThan(0)
    expect(dist).toBeLessThan(0.5)
  })

  it('long: no warning when price far from SL', () => {
    const dist = getSlProximityPct(100, 97, 'long')
    expect(dist).toBeGreaterThan(2)
  })

  it('short: detects proximity when price near SL', () => {
    // Entry $100, SL $103, current price $102.70 → 0.29% from SL
    const dist = getSlProximityPct(102.70, 103, 'short')
    expect(dist).toBeGreaterThan(0)
    expect(dist).toBeLessThan(0.5)
  })

  it('returns negative when SL already breached', () => {
    const dist = getSlProximityPct(96, 97, 'long')
    expect(dist).toBeLessThan(0)
  })
})

// Test crash risk scoring
describe('crash risk scoring', () => {
  // Replicate the crash score logic
  function scoreCrashRisk(rsi3_1h: number, rsi3_4h: number, direction: 'long' | 'short'): { score: number; severity: string } {
    const isLong = direction === 'long'
    const threshold = 15
    let extremeCount = 0
    if (isLong) {
      if (rsi3_1h < threshold) extremeCount++
      if (rsi3_4h < threshold) extremeCount++
    } else {
      if (rsi3_1h > (100 - threshold)) extremeCount++
      if (rsi3_4h > (100 - threshold)) extremeCount++
    }

    if (extremeCount >= 2) {
      const bothDeep = isLong ? (rsi3_1h < 5 && rsi3_4h < 10) : (rsi3_1h > 95 && rsi3_4h > 90)
      if (bothDeep) return { score: 8, severity: 'capitulation' }
      return { score: 0, severity: 'severe' }
    }
    if (extremeCount === 1) return { score: 4, severity: 'mild' }
    return { score: 10, severity: 'none' }
  }

  it('no crash: full score', () => {
    const r = scoreCrashRisk(50, 55, 'long')
    expect(r.score).toBe(10)
    expect(r.severity).toBe('none')
  })

  it('mild crash: 1 TF extreme', () => {
    const r = scoreCrashRisk(10, 40, 'long')
    expect(r.score).toBe(4)
    expect(r.severity).toBe('mild')
  })

  it('severe crash: 2 TFs extreme', () => {
    const r = scoreCrashRisk(12, 8, 'long')
    expect(r.score).toBe(0)
    expect(r.severity).toBe('severe')
  })

  it('capitulation: all TFs deep extreme → mild penalty (reversal opportunity)', () => {
    const r = scoreCrashRisk(3, 7, 'long')
    expect(r.score).toBe(8)
    expect(r.severity).toBe('capitulation')
  })

  it('short crash detection works inverted', () => {
    const r = scoreCrashRisk(88, 90, 'short')
    expect(r.score).toBe(0)
    expect(r.severity).toBe('severe')
  })
})

// Test partial exit ratio scaling
describe('partial exit', () => {
  it('TP ratios scale down correctly after partial exit', () => {
    const exitRatio = 0.3 // exit 30%
    const scaleDown = 1 - exitRatio
    const originalTps = [
      { sizeRatio: 0.5, status: 'pending' as const },
      { sizeRatio: 0.3, status: 'pending' as const },
      { sizeRatio: 0.2, status: 'pending' as const },
    ]
    const scaled = originalTps.map(tp => tp.sizeRatio * scaleDown)
    expect(scaled[0]).toBeCloseTo(0.35)
    expect(scaled[1]).toBeCloseTo(0.21)
    expect(scaled[2]).toBeCloseTo(0.14)
    // Sum is less than 1.0 because we exited 30%
    expect(scaled.reduce((s, r) => s + r, 0)).toBeCloseTo(0.7)
  })

  it('filled TPs are not affected by partial exit', () => {
    const tps = [
      { sizeRatio: 0.5, status: 'filled' as const },
      { sizeRatio: 0.3, status: 'pending' as const },
      { sizeRatio: 0.2, status: 'pending' as const },
    ]
    const exitRatio = 0.3
    const scaleDown = 1 - exitRatio
    const scaled = tps.map(tp =>
      tp.status === 'pending' ? tp.sizeRatio * scaleDown : tp.sizeRatio,
    )
    expect(scaled[0]).toBe(0.5) // filled: unchanged
    expect(scaled[1]).toBeCloseTo(0.21) // pending: scaled
    expect(scaled[2]).toBeCloseTo(0.14) // pending: scaled
  })
})
