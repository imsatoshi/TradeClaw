import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  createScheduler,
  isWithinActiveHours,
  parseDuration,
  stripAckToken,
  isHeartbeatFileEmpty,
  HeartbeatDedup,
  type HeartbeatResult,
  type SchedulerConfig,
} from './scheduler.js'
import { _resetForTest, enqueueSystemEvent } from './agent-events.js'

beforeEach(() => {
  _resetForTest()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ==================== Helper ====================

function defaultConfig(overrides?: Partial<SchedulerConfig['heartbeat']>): SchedulerConfig {
  return {
    heartbeat: {
      enabled: true,
      every: '30m',
      prompt: 'Check HEARTBEAT.md and report.',
      ackToken: 'HEARTBEAT_OK',
      ackMaxChars: 300,
      activeHours: null,
      ...overrides,
    },
  }
}

const okResult: HeartbeatResult = { status: 'sent', text: 'All good' }
const ackResult: HeartbeatResult = { status: 'ok-ack' }

describe('parseDuration', () => {
  it('should parse minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000)
  })

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3600 * 1000)
  })

  it('should parse combined', () => {
    expect(parseDuration('1h30m')).toBe(90 * 60 * 1000)
  })

  it('should parse seconds', () => {
    expect(parseDuration('5m30s')).toBe(330 * 1000)
  })

  it('should return null for invalid input', () => {
    expect(parseDuration('')).toBe(null)
    expect(parseDuration('abc')).toBe(null)
    expect(parseDuration('0h0m0s')).toBe(null)
  })
})

describe('isWithinActiveHours', () => {
  it('should return true when no activeHours configured', () => {
    expect(isWithinActiveHours(null)).toBe(true)
  })

  it('should detect within normal range', () => {
    const ah = { start: '09:00', end: '22:00', timezone: 'local' }
    // 12:00 local
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    expect(isWithinActiveHours(ah, noon.getTime())).toBe(true)
  })

  it('should detect outside normal range', () => {
    const ah = { start: '09:00', end: '22:00', timezone: 'local' }
    const midnight = new Date()
    midnight.setHours(2, 0, 0, 0)
    expect(isWithinActiveHours(ah, midnight.getTime())).toBe(false)
  })

  it('should handle overnight range', () => {
    const ah = { start: '22:00', end: '06:00', timezone: 'local' }
    const lateNight = new Date()
    lateNight.setHours(23, 0, 0, 0)
    expect(isWithinActiveHours(ah, lateNight.getTime())).toBe(true)

    const earlyMorning = new Date()
    earlyMorning.setHours(3, 0, 0, 0)
    expect(isWithinActiveHours(ah, earlyMorning.getTime())).toBe(true)

    const afternoon = new Date()
    afternoon.setHours(14, 0, 0, 0)
    expect(isWithinActiveHours(ah, afternoon.getTime())).toBe(false)
  })

  it('should return true on parse failure (fail-open)', () => {
    const ah = { start: 'bad', end: '22:00', timezone: 'local' }
    expect(isWithinActiveHours(ah)).toBe(true)
  })
})

describe('stripAckToken', () => {
  const token = 'HEARTBEAT_OK'

  it('should detect pure ack response', () => {
    const r = stripAckToken('HEARTBEAT_OK', token, 300)
    expect(r.shouldSkip).toBe(true)
    expect(r.text).toBe('')
  })

  it('should detect ack with markdown wrapping', () => {
    const r = stripAckToken('**HEARTBEAT_OK**', token, 300)
    expect(r.shouldSkip).toBe(true)
  })

  it('should detect ack with surrounding whitespace', () => {
    const r = stripAckToken('  HEARTBEAT_OK  ', token, 300)
    expect(r.shouldSkip).toBe(true)
  })

  it('should detect short ack noise', () => {
    const r = stripAckToken('HEARTBEAT_OK - all good', token, 300)
    expect(r.shouldSkip).toBe(true)
    expect(r.text).toBe('- all good')
  })

  it('should pass through real content', () => {
    const long = 'BTC dropped 5% in the last hour. You should check your positions. ' +
      'The support level at $95k was broken and the next support is around $92k. ' +
      'I recommend reviewing your stop-loss settings. Also, ETH/BTC ratio is declining. ' +
      'Consider reducing exposure to altcoins.'
    const r = stripAckToken(long, token, 300)
    expect(r.shouldSkip).toBe(false)
    expect(r.text).toBe(long)
  })

  it('should strip token from mixed content and pass through if long enough', () => {
    const long = 'HEARTBEAT_OK but also ' + 'x'.repeat(400)
    const r = stripAckToken(long, token, 300)
    expect(r.shouldSkip).toBe(false)
  })

  it('should handle empty input', () => {
    const r = stripAckToken('', token, 300)
    expect(r.shouldSkip).toBe(true)
  })
})

describe('createScheduler', () => {
  it('should call runOnce on requestWake after coalesce window', async () => {
    const calls: string[] = []
    const runOnce = vi.fn(async () => {
      calls.push('run')
      return okResult
    })

    const scheduler = createScheduler(
      defaultConfig({ enabled: false }), // disable interval, test manual wake
      runOnce,
      { coalesceMs: 50 },
    )

    scheduler.requestWake('manual')
    expect(runOnce).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(50)
    expect(runOnce).toHaveBeenCalledOnce()
    expect(runOnce).toHaveBeenCalledWith(expect.objectContaining({ reason: 'manual' }))

    scheduler.stop()
  })

  it('should coalesce multiple wakes, keeping highest priority', async () => {
    const reasons: string[] = []
    const runOnce = vi.fn(async (opts: { reason: string }) => {
      reasons.push(opts.reason)
      return okResult
    })

    const scheduler = createScheduler(
      defaultConfig({ enabled: false }),
      runOnce,
      { coalesceMs: 100 },
    )

    scheduler.requestWake('interval')  // priority 1
    scheduler.requestWake('cron')      // priority 2 → preempts
    scheduler.requestWake('retry')     // priority 0 → ignored

    await vi.advanceTimersByTimeAsync(100)

    expect(runOnce).toHaveBeenCalledOnce()
    expect(reasons[0]).toBe('cron') // highest priority wins

    scheduler.stop()
  })

  it('should prevent overlapping runs', async () => {
    let concurrent = 0
    let maxConcurrent = 0

    const runOnce = vi.fn(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 200))
      concurrent--
      return okResult
    })

    const scheduler = createScheduler(
      defaultConfig({ enabled: false }),
      runOnce,
      { coalesceMs: 10 },
    )

    scheduler.requestWake('manual')
    await vi.advanceTimersByTimeAsync(10) // flush first

    scheduler.requestWake('manual')      // should be blocked by running
    await vi.advanceTimersByTimeAsync(10) // try to flush second

    // Advance past the first run
    await vi.advanceTimersByTimeAsync(200)

    expect(maxConcurrent).toBe(1)

    scheduler.stop()
  })

  it('should fire interval heartbeats when enabled', async () => {
    const runOnce = vi.fn(async () => okResult)

    const scheduler = createScheduler(
      defaultConfig({ every: '1m' }), // 60s interval
      runOnce,
      { coalesceMs: 10 },
    )

    // First interval fires at 60s
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(10) // coalesce

    expect(runOnce).toHaveBeenCalledOnce()

    scheduler.stop()
  })

  it('should skip heartbeat outside active hours', async () => {
    const runOnce = vi.fn(async () => okResult)

    // Set active hours that exclude current time
    const now = new Date()
    const outOfRange = now.getHours() < 12
      ? { start: '13:00', end: '14:00', timezone: 'local' as const }
      : { start: '01:00', end: '02:00', timezone: 'local' as const }

    const scheduler = createScheduler(
      defaultConfig({ every: '1m', activeHours: outOfRange }),
      runOnce,
      { coalesceMs: 10 },
    )

    await vi.advanceTimersByTimeAsync(60_000 + 10) // interval + coalesce

    // runOnce should NOT have been called (outside active hours)
    expect(runOnce).not.toHaveBeenCalled()

    scheduler.stop()
  })

  it('should pass system events from agent-events queue', async () => {
    let receivedEvents: unknown[] = []
    const runOnce = vi.fn(async (opts: { systemEvents: unknown[] }) => {
      receivedEvents = opts.systemEvents
      return okResult
    })

    const scheduler = createScheduler(
      defaultConfig({ enabled: false }),
      runOnce,
      { coalesceMs: 10 },
    )

    // Inject system events before wake
    enqueueSystemEvent({ id: 'cron:1', source: 'cron', text: 'Time to check portfolio' })

    scheduler.requestWake('cron')
    await vi.advanceTimersByTimeAsync(10)

    expect(receivedEvents).toHaveLength(1)
    expect(receivedEvents[0]).toMatchObject({
      id: 'cron:1',
      source: 'cron',
      text: 'Time to check portfolio',
    })

    scheduler.stop()
  })

  it('should auto-retry on failure', async () => {
    let callCount = 0
    const runOnce = vi.fn(async () => {
      callCount++
      if (callCount === 1) throw new Error('network error')
      return okResult
    })

    const scheduler = createScheduler(
      defaultConfig({ enabled: false }),
      runOnce,
      { coalesceMs: 10 },
    )

    scheduler.requestWake('manual')
    await vi.advanceTimersByTimeAsync(10) // flush → fails

    // Retry after 1000ms (RETRY_DELAY_MS) + coalesce
    await vi.advanceTimersByTimeAsync(1000 + 10)

    expect(callCount).toBe(2) // retried once

    scheduler.stop()
  })

  it('stop should prevent further runs', async () => {
    const runOnce = vi.fn(async () => okResult)

    const scheduler = createScheduler(
      defaultConfig({ every: '1m' }),
      runOnce,
      { coalesceMs: 10 },
    )

    scheduler.stop()

    await vi.advanceTimersByTimeAsync(120_000)

    expect(runOnce).not.toHaveBeenCalled()
  })

  // ---- Bug reproductions ----

  it('BUG: should not lose system events when runOnce skips (engine-busy)', async () => {
    // Reproduce: cron fires → system event enqueued → scheduler wakes →
    // flush drains events → runOnce returns 'skipped' (engine busy) →
    // events are gone forever, never delivered.
    const receivedEvents: unknown[][] = []
    let callCount = 0
    const runOnce = vi.fn(async (opts: { systemEvents: unknown[] }) => {
      callCount++
      receivedEvents.push(opts.systemEvents)
      // First call: simulate engine-busy skip
      if (callCount === 1) {
        return { status: 'skipped' as const, reason: 'engine-busy' }
      }
      return okResult
    })

    const scheduler = createScheduler(
      defaultConfig({ enabled: false }),
      runOnce,
      { coalesceMs: 10 },
    )

    // Cron injects a system event
    enqueueSystemEvent({ id: 'cron:drink-water', source: 'cron', text: 'Reminder: drink water' })

    // Cron wake arrives
    scheduler.requestWake('cron')
    await vi.advanceTimersByTimeAsync(10) // coalesce → flush → runOnce returns skipped

    // At this point the event has been drained. A subsequent wake should still see it.
    // Wait for auto-retry or manual retry
    await vi.advanceTimersByTimeAsync(1000 + 10) // RETRY_DELAY_MS + coalesce

    // The system event should eventually reach runOnce successfully
    const allEvents = receivedEvents.flat()
    expect(allEvents).toContainEqual(
      expect.objectContaining({ id: 'cron:drink-water', text: 'Reminder: drink water' }),
    )
    // And the second call should have actually processed it
    expect(callCount).toBeGreaterThanOrEqual(2)

    scheduler.stop()
  })

  it('BUG: should not lose wake when flush is called while running', async () => {
    // Reproduce: heartbeat runOnce is executing (slow) → cron wake arrives →
    // flush sees running=true, returns immediately → pendingReason cleared →
    // wake lost, system event never processed.
    const receivedEvents: unknown[][] = []
    const runOnce = vi.fn(async (opts: { systemEvents: unknown[] }) => {
      receivedEvents.push(opts.systemEvents)
      // Simulate slow run
      await new Promise((r) => setTimeout(r, 500))
      return okResult
    })

    const scheduler = createScheduler(
      defaultConfig({ enabled: false }),
      runOnce,
      { coalesceMs: 10 },
    )

    // First wake: manual (starts a slow runOnce)
    scheduler.requestWake('manual')
    await vi.advanceTimersByTimeAsync(10) // coalesce → flush → runOnce starts (takes 500ms)

    // While running: cron fires, injects event, wakes scheduler
    enqueueSystemEvent({ id: 'cron:reminder', source: 'cron', text: 'Check portfolio' })
    scheduler.requestWake('cron')
    await vi.advanceTimersByTimeAsync(10) // coalesce → flush → running=true → drops!

    // First run finishes
    await vi.advanceTimersByTimeAsync(500)

    // Wait a bit for any retry
    await vi.advanceTimersByTimeAsync(1000 + 10)

    // The cron system event should eventually be delivered
    const allEvents = receivedEvents.flat()
    expect(allEvents).toContainEqual(
      expect.objectContaining({ id: 'cron:reminder', text: 'Check portfolio' }),
    )

    scheduler.stop()
  })

  it('hasPendingWake should reflect state', async () => {
    const runOnce = vi.fn(async () => {
      // Simulate slow run
      await new Promise((r) => setTimeout(r, 100))
      return okResult
    })

    const scheduler = createScheduler(
      defaultConfig({ enabled: false }),
      runOnce,
      { coalesceMs: 10 },
    )

    expect(scheduler.hasPendingWake()).toBe(false)

    scheduler.requestWake('manual')
    expect(scheduler.hasPendingWake()).toBe(true)

    await vi.advanceTimersByTimeAsync(10)
    // Now running
    expect(scheduler.hasPendingWake()).toBe(true)

    await vi.advanceTimersByTimeAsync(100)
    expect(scheduler.hasPendingWake()).toBe(false)

    scheduler.stop()
  })
})

// ==================== isHeartbeatFileEmpty ====================

describe('isHeartbeatFileEmpty', () => {
  it('should return true for empty string', () => {
    expect(isHeartbeatFileEmpty('')).toBe(true)
  })

  it('should return true for only whitespace', () => {
    expect(isHeartbeatFileEmpty('   \n\n  \n')).toBe(true)
  })

  it('should return true for only markdown headers', () => {
    expect(isHeartbeatFileEmpty('# HEARTBEAT.md\n\n## Tasks\n')).toBe(true)
  })

  it('should return true for headers + empty list items', () => {
    expect(isHeartbeatFileEmpty('# Tasks\n- \n* \n')).toBe(true)
  })

  it('should return true for HTML comments only', () => {
    expect(isHeartbeatFileEmpty('# HEARTBEAT\n<!-- keep empty to skip -->\n')).toBe(true)
  })

  it('should return false for content with a task', () => {
    expect(isHeartbeatFileEmpty('# Tasks\n- Check BTC price\n')).toBe(false)
  })

  it('should return false for a single line of text', () => {
    expect(isHeartbeatFileEmpty('Check portfolio')).toBe(false)
  })

  it('should return false for list item with content', () => {
    expect(isHeartbeatFileEmpty('- Monitor ETH/BTC ratio')).toBe(false)
  })

  it('should handle the template file (headers + comments only)', () => {
    const template = [
      '# HEARTBEAT.md',
      '',
      '# Keep this file empty (or with only comments) to skip heartbeat API calls.',
      '',
      '# Add tasks below when you want the agent to check something periodically.',
    ].join('\n')
    // This has text after the # in headers — "# Keep this file..." is a header,
    // so it should be treated as empty
    expect(isHeartbeatFileEmpty(template)).toBe(true)
  })
})

// ==================== HeartbeatDedup ====================

describe('HeartbeatDedup', () => {
  it('should not flag first message as duplicate', () => {
    const dedup = new HeartbeatDedup()
    expect(dedup.isDuplicate('BTC dropped 5%', 1000)).toBe(false)
  })

  it('should flag identical message within window', () => {
    const dedup = new HeartbeatDedup(60_000) // 1 minute window
    const t = 1000
    dedup.record('BTC dropped 5%', t)
    expect(dedup.isDuplicate('BTC dropped 5%', t + 30_000)).toBe(true)
  })

  it('should not flag different message', () => {
    const dedup = new HeartbeatDedup(60_000)
    dedup.record('BTC dropped 5%', 1000)
    expect(dedup.isDuplicate('ETH dropped 3%', 2000)).toBe(false)
  })

  it('should not flag same message after window expires', () => {
    const dedup = new HeartbeatDedup(60_000)
    const t = 1000
    dedup.record('BTC dropped 5%', t)
    expect(dedup.isDuplicate('BTC dropped 5%', t + 60_001)).toBe(false)
  })

  it('should update record on new delivery', () => {
    const dedup = new HeartbeatDedup(60_000)
    dedup.record('message A', 1000)
    dedup.record('message B', 2000)
    // message A is no longer tracked
    expect(dedup.isDuplicate('message A', 3000)).toBe(false)
    expect(dedup.isDuplicate('message B', 3000)).toBe(true)
  })

  it('should use default 24h window', () => {
    const dedup = new HeartbeatDedup()
    const t = 1000
    dedup.record('alert', t)
    // 23h59m later — still duplicate
    expect(dedup.isDuplicate('alert', t + 23 * 60 * 60 * 1000 + 59 * 60 * 1000)).toBe(true)
    // 24h later — no longer duplicate
    expect(dedup.isDuplicate('alert', t + 24 * 60 * 60 * 1000 + 1)).toBe(false)
  })
})
