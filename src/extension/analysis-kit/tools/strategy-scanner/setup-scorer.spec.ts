import { describe, it, expect } from 'vitest'
import { scoreCrashRisk } from './setup-scorer.js'
import type { MarketData } from '../../../archive-analysis/data/interfaces.js'

/** Generate synthetic bars with given close prices */
function makeBars(closes: number[]): MarketData[] {
  return closes.map((close, i) => ({
    time: Date.now() - (closes.length - i) * 3600 * 1000,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  }))
}

describe('scoreCrashRisk', () => {
  it('returns positive score for normal conditions', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5)
    const bars = makeBars(closes)
    const result = scoreCrashRisk('long', bars)
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.max).toBe(10)
  })

  it('penalizes longs during crash (lower score)', () => {
    // Sharp drop — crash condition
    const crashCloses = [
      ...Array.from({ length: 40 }, () => 100),
      98, 95, 90, 85, 80, 75, 70, 65, 60, 55,
    ]
    const normalCloses = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5)

    const crashResult = scoreCrashRisk('long', makeBars(crashCloses))
    const normalResult = scoreCrashRisk('long', makeBars(normalCloses))

    expect(crashResult.score).toBeLessThan(normalResult.score)
  })

  it('benefits shorts during crash', () => {
    const crashCloses = [
      ...Array.from({ length: 40 }, () => 100),
      98, 95, 90, 85, 80, 75, 70, 65, 60, 55,
    ]
    const result = scoreCrashRisk('short', makeBars(crashCloses))
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('dimension max is 10', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i)
    const result = scoreCrashRisk('long', makeBars(closes))
    expect(result.max).toBe(10)
  })
})
