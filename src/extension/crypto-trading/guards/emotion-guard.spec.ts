import { describe, it, expect } from 'vitest'
import { EmotionGuard } from './emotion-guard.js'
import type { GuardContext } from './guard-pipeline.js'

function makeCtx(usdSize: number): GuardContext {
  return {
    operation: {
      action: 'placeOrder',
      params: { symbol: 'BTC/USDT', side: 'buy', type: 'market', usd_size: usdSize },
    },
    positions: [],
    account: { balance: 5000, equity: 10000, totalMargin: 5000, unrealizedPnL: 0, realizedPnL: 0, totalPnL: 0 },
  }
}

describe('EmotionGuard', () => {
  it('allows trade at full size when emotion is neutral', () => {
    const guard = new EmotionGuard(() => 'neutral')
    const ctx = makeCtx(100)
    const result = guard.check(ctx)
    expect(result.allowed).toBe(true)
    expect(ctx.operation.params.usd_size).toBe(100)
  })

  it('allows trade at full size when emotion is confident', () => {
    const guard = new EmotionGuard(() => 'confident')
    const ctx = makeCtx(200)
    const result = guard.check(ctx)
    expect(result.allowed).toBe(true)
    expect(ctx.operation.params.usd_size).toBe(200)
  })

  it('reduces size to 50% when emotion is cautious', () => {
    const guard = new EmotionGuard(() => 'cautious')
    const ctx = makeCtx(100)
    const result = guard.check(ctx)
    expect(result.allowed).toBe(true)
    expect(ctx.operation.params.usd_size).toBe(50)
  })

  it('reduces size to 25% when emotion is scared', () => {
    const guard = new EmotionGuard(() => 'feeling scared')
    const ctx = makeCtx(100)
    const result = guard.check(ctx)
    expect(result.allowed).toBe(true)
    expect(ctx.operation.params.usd_size).toBe(25)
  })

  it('blocks trade when emotion is angry', () => {
    const guard = new EmotionGuard(() => 'angry')
    const result = guard.check(makeCtx(100))
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('angry')
  })

  it('blocks trade when emotion is tilted', () => {
    const guard = new EmotionGuard(() => 'tilted after loss')
    const result = guard.check(makeCtx(100))
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('tilted')
  })

  it('allows reduceOnly orders regardless of emotion', () => {
    const guard = new EmotionGuard(() => 'angry')
    const ctx: GuardContext = {
      operation: {
        action: 'placeOrder',
        params: { symbol: 'BTC/USDT', side: 'sell', type: 'market', reduceOnly: true },
      },
      positions: [],
      account: { balance: 5000, equity: 10000, totalMargin: 5000, unrealizedPnL: 0, realizedPnL: 0, totalPnL: 0 },
    }
    const result = guard.check(ctx)
    expect(result.allowed).toBe(true)
  })

  it('allows non-placeOrder operations regardless of emotion', () => {
    const guard = new EmotionGuard(() => 'angry')
    const ctx: GuardContext = {
      operation: { action: 'closePosition', params: { symbol: 'BTC/USDT' } },
      positions: [],
      account: { balance: 5000, equity: 10000, totalMargin: 5000, unrealizedPnL: 0, realizedPnL: 0, totalPnL: 0 },
    }
    const result = guard.check(ctx)
    expect(result.allowed).toBe(true)
  })

  it('allows unknown emotions at full size', () => {
    const guard = new EmotionGuard(() => 'contemplative')
    const ctx = makeCtx(100)
    const result = guard.check(ctx)
    expect(result.allowed).toBe(true)
    expect(ctx.operation.params.usd_size).toBe(100)
  })
})
