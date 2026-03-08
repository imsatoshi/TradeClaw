import { describe, it, expect } from 'vitest'
import { AccountDrawdownGuard } from './account-drawdown-guard.js'
import type { GuardContext } from './guard-pipeline.js'

function makeCtx(equity: number, action: string = 'placeOrder', reduceOnly = false): GuardContext {
  return {
    operation: {
      action,
      params: { symbol: 'BTC/USDT', side: 'buy', type: 'market', reduceOnly },
    },
    positions: [],
    account: { balance: equity, equity, totalMargin: 0, unrealizedPnL: 0, realizedPnL: 0, totalPnL: 0 },
  }
}

describe('AccountDrawdownGuard', () => {
  it('allows trade when equity is at watermark', () => {
    const guard = new AccountDrawdownGuard({ maxDailyPercent: 5 })
    const result = guard.check(makeCtx(10000))
    expect(result.allowed).toBe(true)
  })

  it('allows trade within drawdown threshold', () => {
    const guard = new AccountDrawdownGuard({ maxDailyPercent: 5 })
    // Set watermark at 10000
    guard.check(makeCtx(10000))
    // Drop to 9600 (4% drawdown, under 5% limit)
    const result = guard.check(makeCtx(9600))
    expect(result.allowed).toBe(true)
  })

  it('blocks trade when drawdown exceeds threshold', () => {
    const guard = new AccountDrawdownGuard({ maxDailyPercent: 5 })
    // Set watermark at 10000
    guard.check(makeCtx(10000))
    // Drop to 9400 (6% drawdown, over 5% limit)
    const result = guard.check(makeCtx(9400))
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('6.00%')
    expect(result.reason).toContain('exceeds 5%')
  })

  it('allows reduceOnly orders even during drawdown', () => {
    const guard = new AccountDrawdownGuard({ maxDailyPercent: 5 })
    guard.check(makeCtx(10000))
    const result = guard.check(makeCtx(9000, 'placeOrder', true))
    expect(result.allowed).toBe(true)
  })

  it('allows non-placeOrder operations during drawdown', () => {
    const guard = new AccountDrawdownGuard({ maxDailyPercent: 5 })
    guard.check(makeCtx(10000))
    const result = guard.check(makeCtx(9000, 'closePosition'))
    expect(result.allowed).toBe(true)
  })

  it('updates watermark when equity rises', () => {
    const guard = new AccountDrawdownGuard({ maxDailyPercent: 5 })
    guard.check(makeCtx(10000))
    // Equity rises to 11000 — new watermark
    guard.check(makeCtx(11000))
    // Drop to 10500 (4.5% from 11000, under 5%)
    const result = guard.check(makeCtx(10500))
    expect(result.allowed).toBe(true)
    // Drop to 10400 (5.5% from 11000, over 5%)
    const result2 = guard.check(makeCtx(10400))
    expect(result2.allowed).toBe(false)
  })

  it('uses default 5% threshold', () => {
    const guard = new AccountDrawdownGuard()
    guard.check(makeCtx(10000))
    // 4.9% drawdown — allowed
    expect(guard.check(makeCtx(9510)).allowed).toBe(true)
    // 5.1% drawdown — blocked
    expect(guard.check(makeCtx(9490)).allowed).toBe(false)
  })

  it('allows trade when equity is zero or negative', () => {
    const guard = new AccountDrawdownGuard({ maxDailyPercent: 5 })
    expect(guard.check(makeCtx(0)).allowed).toBe(true)
    expect(guard.check(makeCtx(-100)).allowed).toBe(true)
  })
})
