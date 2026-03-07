import { describe, it, expect, vi } from 'vitest'
import { withBackoff, isTransientError } from './retry.js'

describe('withBackoff', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withBackoff(fn, { maxRetries: 3 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on transient failure and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('ok')
    const result = await withBackoff(fn, { maxRetries: 3, baseDelayMs: 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws after all retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    await expect(
      withBackoff(fn, { maxRetries: 2, baseDelayMs: 1 }),
    ).rejects.toThrow('fail')
    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('throws immediately for permanent errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('unauthorized'))
    await expect(
      withBackoff(fn, { maxRetries: 3, baseDelayMs: 1, isTransient: isTransientError }),
    ).rejects.toThrow('unauthorized')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('isTransientError', () => {
  it('returns false for auth errors', () => {
    expect(isTransientError(new Error('unauthorized'))).toBe(false)
    expect(isTransientError(new Error('invalid api key'))).toBe(false)
    expect(isTransientError(new Error('403 forbidden'))).toBe(false)
  })

  it('returns true for unknown errors', () => {
    expect(isTransientError(new Error('connection reset'))).toBe(true)
    expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true)
  })

  it('returns true for non-Error objects', () => {
    expect(isTransientError('string error')).toBe(true)
    expect(isTransientError(42)).toBe(true)
  })
})
