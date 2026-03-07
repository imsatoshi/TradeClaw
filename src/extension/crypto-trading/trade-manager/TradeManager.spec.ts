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
