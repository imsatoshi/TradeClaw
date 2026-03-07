import { describe, it, expect } from 'vitest'
import { createThinkBeforeTradeTools } from './think-before-trade.js'

const tools = createThinkBeforeTradeTools()
const execute = (tools.thinkBeforeTrade as any).execute

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTC/USDT',
    direction: 'long' as const,
    edge: 'RSI oversold bounce + volume spike',
    risk: 'False breakout, continued downtrend',
    confidence: 75,
    scannerGrade: 'A' as const,
    checklist: {
      positionSizeOk: true,
      newsChecked: true,
      noRecentLoss: true,
    },
    ...overrides,
  }
}

describe('thinkBeforeTrade', () => {
  it('approves valid trade with confirm mode (auto-trade disabled by default)', async () => {
    const result = await execute(baseInput())
    expect(result.approved).toBe(true)
    expect(result.executionMode).toBe('confirm')
    expect(result.confidence).toBe(75)
  })

  it('blocks trade when confidence < 60', async () => {
    const result = await execute(baseInput({ confidence: 50 }))
    expect(result.approved).toBe(false)
    expect(result.executionMode).toBe('blocked')
    expect(result.reason).toContain('confidence 50')
  })

  it('blocks trade when checklist.positionSizeOk is false', async () => {
    const result = await execute(baseInput({
      checklist: { positionSizeOk: false, newsChecked: true, noRecentLoss: true },
    }))
    expect(result.approved).toBe(false)
    expect(result.reason).toContain('position size not verified')
  })

  it('blocks trade when checklist.newsChecked is false', async () => {
    const result = await execute(baseInput({
      checklist: { positionSizeOk: true, newsChecked: false, noRecentLoss: true },
    }))
    expect(result.approved).toBe(false)
    expect(result.reason).toContain('news not checked')
  })

  it('blocks trade when checklist.noRecentLoss is false', async () => {
    const result = await execute(baseInput({
      checklist: { positionSizeOk: true, newsChecked: true, noRecentLoss: false },
    }))
    expect(result.approved).toBe(false)
    expect(result.reason).toContain('cooldown')
  })

  it('blocks Grade C without AI override', async () => {
    const result = await execute(baseInput({ scannerGrade: 'C' }))
    expect(result.approved).toBe(false)
    expect(result.reason).toContain('Grade C')
  })

  it('allows Grade C with AI override', async () => {
    const result = await execute(baseInput({
      scannerGrade: 'C',
      aiOverride: 'Clear divergence pattern visible despite low scanner score',
    }))
    expect(result.approved).toBe(true)
  })

  it('collects multiple block reasons', async () => {
    const result = await execute(baseInput({
      confidence: 40,
      checklist: { positionSizeOk: false, newsChecked: false, noRecentLoss: false },
    }))
    expect(result.approved).toBe(false)
    expect(result.reason).toContain('confidence 40')
    expect(result.reason).toContain('position size')
    expect(result.reason).toContain('news')
    expect(result.reason).toContain('cooldown')
  })
})
