import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  enqueue,
  ack,
  fail,
  moveToFailed,
  loadPending,
  recoverPending,
  computeBackoffMs,
  type DeliveryQueueConfig,
  type DeliveryEntry,
} from './delivery.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'delivery-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function testConfig(): DeliveryQueueConfig {
  return {
    queueDir: join(tempDir, 'queue'),
    maxRetries: 5,
  }
}

describe('computeBackoffMs', () => {
  it('should return 0 for retry 0', () => {
    expect(computeBackoffMs(0)).toBe(0)
  })

  it('should return escalating delays', () => {
    expect(computeBackoffMs(1)).toBe(5_000)
    expect(computeBackoffMs(2)).toBe(25_000)
    expect(computeBackoffMs(3)).toBe(120_000)
    expect(computeBackoffMs(4)).toBe(600_000)
  })

  it('should clamp at max backoff for high retry counts', () => {
    expect(computeBackoffMs(5)).toBe(600_000)
    expect(computeBackoffMs(100)).toBe(600_000)
  })
})

describe('enqueue / loadPending', () => {
  it('should persist an entry to disk and load it back', async () => {
    const config = testConfig()

    const id = await enqueue(config, {
      channel: 'telegram',
      to: '12345',
      text: 'Hello from heartbeat',
    })

    expect(typeof id).toBe('string')

    const pending = await loadPending(config)
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe(id)
    expect(pending[0].channel).toBe('telegram')
    expect(pending[0].to).toBe('12345')
    expect(pending[0].text).toBe('Hello from heartbeat')
    expect(pending[0].retryCount).toBe(0)
  })

  it('should support optional meta field', async () => {
    const config = testConfig()

    await enqueue(config, {
      channel: 'webhook',
      to: 'https://example.com/hook',
      text: 'alert',
      meta: { token: 'abc123' },
    })

    const pending = await loadPending(config)
    expect(pending[0].meta).toEqual({ token: 'abc123' })
  })

  it('should return empty array for nonexistent queue dir', async () => {
    const config = { queueDir: join(tempDir, 'nonexistent'), maxRetries: 5 }
    const pending = await loadPending(config)
    expect(pending).toHaveLength(0)
  })
})

describe('ack', () => {
  it('should remove a delivered entry', async () => {
    const config = testConfig()
    const id = await enqueue(config, { channel: 'telegram', to: '1', text: 'test' })

    await ack(config, id)

    const pending = await loadPending(config)
    expect(pending).toHaveLength(0)
  })

  it('should be idempotent (no error on double ack)', async () => {
    const config = testConfig()
    const id = await enqueue(config, { channel: 'telegram', to: '1', text: 'test' })

    await ack(config, id)
    await ack(config, id) // should not throw
  })
})

describe('fail', () => {
  it('should increment retryCount and record error', async () => {
    const config = testConfig()
    const id = await enqueue(config, { channel: 'telegram', to: '1', text: 'test' })

    await fail(config, id, 'network timeout')

    const pending = await loadPending(config)
    expect(pending[0].retryCount).toBe(1)
    expect(pending[0].lastError).toBe('network timeout')
  })

  it('should accumulate retries', async () => {
    const config = testConfig()
    const id = await enqueue(config, { channel: 'telegram', to: '1', text: 'test' })

    await fail(config, id, 'error 1')
    await fail(config, id, 'error 2')
    await fail(config, id, 'error 3')

    const pending = await loadPending(config)
    expect(pending[0].retryCount).toBe(3)
    expect(pending[0].lastError).toBe('error 3')
  })
})

describe('moveToFailed', () => {
  it('should move entry to failed/ subdirectory', async () => {
    const config = testConfig()
    const id = await enqueue(config, { channel: 'telegram', to: '1', text: 'test' })

    await moveToFailed(config, id)

    // No longer in main queue
    const pending = await loadPending(config)
    expect(pending).toHaveLength(0)

    // Present in failed/
    const failedFiles = await readdir(join(config.queueDir, 'failed'))
    expect(failedFiles).toContain(`${id}.json`)
  })
})

describe('recoverPending', () => {
  it('should recover successfully delivered entries', async () => {
    const config = testConfig()
    await enqueue(config, { channel: 'telegram', to: '1', text: 'msg1' })
    await enqueue(config, { channel: 'telegram', to: '2', text: 'msg2' })

    const delivered: string[] = []
    const result = await recoverPending({
      config,
      deliver: async (entry) => { delivered.push(entry.to) },
      delay: async () => {}, // no-op delay for testing
    })

    expect(result.recovered).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
    expect(delivered.sort()).toEqual(['1', '2'])

    // Queue should be empty after recovery
    const pending = await loadPending(config)
    expect(pending).toHaveLength(0)
  })

  it('should skip entries that exceeded max retries', async () => {
    const config = testConfig()
    const id = await enqueue(config, { channel: 'telegram', to: '1', text: 'test' })

    // Manually set retryCount to max
    for (let i = 0; i < 5; i++) {
      await fail(config, id, `error ${i}`)
    }

    const result = await recoverPending({
      config,
      deliver: async () => {},
      delay: async () => {},
    })

    expect(result.skipped).toBe(1)
    expect(result.recovered).toBe(0)

    // Should have been moved to failed/
    const failedFiles = await readdir(join(config.queueDir, 'failed'))
    expect(failedFiles).toHaveLength(1)
  })

  it('should handle delivery failures during recovery', async () => {
    const config = testConfig()
    await enqueue(config, { channel: 'telegram', to: '1', text: 'will fail' })

    const result = await recoverPending({
      config,
      deliver: async () => { throw new Error('delivery failed') },
      delay: async () => {},
    })

    expect(result.failed).toBe(1)
    expect(result.recovered).toBe(0)

    // Entry should still be in queue with bumped retryCount
    const pending = await loadPending(config)
    expect(pending).toHaveLength(1)
    expect(pending[0].retryCount).toBe(1)
  })

  it('should process oldest entries first', async () => {
    const config = testConfig()

    // Enqueue with slight delay to ensure ordering
    await enqueue(config, { channel: 'telegram', to: 'first', text: 'msg1' })
    await enqueue(config, { channel: 'telegram', to: 'second', text: 'msg2' })

    const order: string[] = []
    await recoverPending({
      config,
      deliver: async (entry) => { order.push(entry.to) },
      delay: async () => {},
    })

    expect(order).toEqual(['first', 'second'])
  })

  it('should respect time budget', async () => {
    const config = testConfig()
    await enqueue(config, { channel: 'telegram', to: '1', text: 'msg1' })
    await enqueue(config, { channel: 'telegram', to: '2', text: 'msg2' })

    const result = await recoverPending({
      config,
      deliver: async () => {},
      delay: async () => {},
      maxRecoveryMs: 0, // immediate deadline
    })

    // Should have bailed out due to time budget
    expect(result.recovered + result.failed + result.skipped).toBeLessThan(2)
  })

  it('should return zeros for empty queue', async () => {
    const config = testConfig()

    const result = await recoverPending({
      config,
      deliver: async () => {},
    })

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 })
  })
})
