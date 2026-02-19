import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runPollingLoop } from '../polling.js'
import type { TelegramClient } from '../client.js'
import type { Update } from '../types.js'
import { textUpdate, resetCounters } from './fixtures.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetCounters()
})

afterEach(() => {
  vi.useRealTimers()
})

function createMockClient() {
  return {
    getUpdates: vi.fn<(offset?: number, timeout?: number, signal?: AbortSignal) => Promise<Update[]>>(),
  } as unknown as TelegramClient & { getUpdates: ReturnType<typeof vi.fn> }
}

describe('runPollingLoop', () => {
  it('polls and delivers updates', async () => {
    const client = createMockClient()
    const controller = new AbortController()
    const received: Update[][] = []

    const update1 = textUpdate('hello')
    const update2 = textUpdate('world')

    // First call returns updates, second call aborts
    client.getUpdates
      .mockResolvedValueOnce([update1, update2])
      .mockImplementation(async () => {
        controller.abort()
        return []
      })

    await runPollingLoop({
      client,
      timeout: 30,
      onUpdates: (updates) => received.push(updates),
      signal: controller.signal,
    })

    expect(received).toHaveLength(1)
    expect(received[0]).toHaveLength(2)
    // Second call should have offset = max(update_id) + 1
    expect(client.getUpdates.mock.calls[1][0]).toBe(update2.update_id + 1)
  })

  it('tracks offset across batches', async () => {
    const client = createMockClient()
    const controller = new AbortController()
    let callCount = 0

    client.getUpdates.mockImplementation(async () => {
      callCount++
      if (callCount === 1) return [textUpdate('a')] // update_id = 1
      if (callCount === 2) return [textUpdate('b')] // update_id = 2
      controller.abort()
      return []
    })

    await runPollingLoop({
      client,
      timeout: 30,
      onUpdates: () => {},
      signal: controller.signal,
    })

    // Call 1: offset=undefined, call 2: offset=2, call 3: offset=3
    expect(client.getUpdates.mock.calls[0][0]).toBeUndefined()
    expect(client.getUpdates.mock.calls[1][0]).toBe(2) // 1 + 1
    expect(client.getUpdates.mock.calls[2][0]).toBe(3) // 2 + 1
  })

  it('backs off on error then resets on success', async () => {
    const client = createMockClient()
    const controller = new AbortController()
    const errors: unknown[] = []
    let callCount = 0

    client.getUpdates.mockImplementation(async () => {
      callCount++
      if (callCount === 1) throw new Error('network')
      if (callCount === 2) throw new Error('network again')
      if (callCount === 3) {
        controller.abort()
        return [textUpdate('ok')]
      }
      return []
    })

    const promise = runPollingLoop({
      client,
      timeout: 30,
      onUpdates: () => {},
      onError: (e) => errors.push(e),
      signal: controller.signal,
    })

    // First error → 1s backoff
    await vi.advanceTimersByTimeAsync(1000)
    // Second error → 2s backoff
    await vi.advanceTimersByTimeAsync(2000)

    await promise

    expect(errors).toHaveLength(2)
    expect(callCount).toBe(3)
  })

  it('stops immediately when signal is aborted', async () => {
    const client = createMockClient()
    const controller = new AbortController()

    client.getUpdates.mockImplementation(async (_offset, _timeout, signal) => {
      // Simulate abort during the long poll
      controller.abort()
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return []
    })

    await runPollingLoop({
      client,
      timeout: 30,
      onUpdates: () => {},
      signal: controller.signal,
    })

    expect(client.getUpdates).toHaveBeenCalledTimes(1)
  })

  it('skips empty update batches', async () => {
    const client = createMockClient()
    const controller = new AbortController()
    const received: Update[][] = []
    let callCount = 0

    client.getUpdates.mockImplementation(async () => {
      callCount++
      if (callCount === 1) return [] // empty
      if (callCount === 2) return [textUpdate('data')]
      controller.abort()
      return []
    })

    await runPollingLoop({
      client,
      timeout: 30,
      onUpdates: (updates) => received.push(updates),
      signal: controller.signal,
    })

    expect(received).toHaveLength(1)
    // Offset should still be undefined after empty batch
    expect(client.getUpdates.mock.calls[1][0]).toBeUndefined()
  })
})
