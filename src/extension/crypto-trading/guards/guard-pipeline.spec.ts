import { describe, it, expect } from 'vitest'
import { runGuardPipeline } from './guard-pipeline.js'
import type { Guard, GuardContext } from './guard-pipeline.js'

const ctx: GuardContext = {
  operation: { action: 'placeOrder', params: { symbol: 'BTC/USDT', side: 'buy', type: 'market' } },
  positions: [],
  account: { balance: 5000, equity: 10000, totalMargin: 5000, unrealizedPnL: 0, realizedPnL: 0, totalPnL: 0 },
}

describe('runGuardPipeline', () => {
  it('allows when all guards pass', async () => {
    const guards: Guard[] = [
      { name: 'PassGuard', check: () => ({ allowed: true }) },
    ]
    const result = await runGuardPipeline(guards, ctx)
    expect(result.allowed).toBe(true)
  })

  it('blocks on first failing guard', async () => {
    const guards: Guard[] = [
      { name: 'PassGuard', check: () => ({ allowed: true }) },
      { name: 'BlockGuard', check: () => ({ allowed: false, reason: 'test block' }) },
    ]
    const result = await runGuardPipeline(guards, ctx)
    expect(result.allowed).toBe(false)
    expect(result.guardName).toBe('BlockGuard')
    expect(result.reason).toBe('test block')
  })

  it('treats throwing guard as blocked (fail-closed)', async () => {
    const guards: Guard[] = [
      { name: 'PassGuard', check: () => ({ allowed: true }) },
      { name: 'CrashGuard', check: () => { throw new Error('guard crashed') } },
    ]
    const result = await runGuardPipeline(guards, ctx)
    expect(result.allowed).toBe(false)
    expect(result.guardName).toBe('CrashGuard')
    expect(result.reason).toContain('guard crashed')
  })

  it('handles async guard exceptions', async () => {
    const guards: Guard[] = [
      { name: 'AsyncCrash', check: async () => { throw new Error('async fail') } },
    ]
    const result = await runGuardPipeline(guards, ctx)
    expect(result.allowed).toBe(false)
    expect(result.guardName).toBe('AsyncCrash')
    expect(result.reason).toContain('async fail')
  })

  it('allows with empty guard list', async () => {
    const result = await runGuardPipeline([], ctx)
    expect(result.allowed).toBe(true)
  })
})
