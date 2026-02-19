import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createCronEngine,
  nextCronFire,
  type CronConfig,
  type CronJob,
} from './cron.js'
import { _resetForTest, drainSystemEvents } from './agent-events.js'

let tempDir: string

beforeEach(async () => {
  _resetForTest()
  vi.useFakeTimers()
  tempDir = await mkdtemp(join(tmpdir(), 'cron-test-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(tempDir, { recursive: true, force: true })
})

function testConfig(): CronConfig {
  return {
    enabled: true,
    storePath: join(tempDir, 'cron-jobs.json'),
  }
}

describe('nextCronFire', () => {
  it('should parse simple cron expressions', () => {
    // "every hour at minute 0" → 0 * * * *
    const base = new Date('2025-06-01T10:30:00Z').getTime()
    const next = nextCronFire('0 * * * *', base)

    expect(next).not.toBeNull()
    const d = new Date(next!)
    expect(d.getUTCMinutes()).toBe(0)
    expect(d.getTime()).toBeGreaterThan(base)
  })

  it('should handle specific hour and minute', () => {
    // "daily at 09:00 local" → 0 9 * * *
    // Use a base time where 09:00 local has already passed today
    const base = new Date()
    base.setHours(10, 0, 0, 0) // 10:00 local — 09:00 already passed
    const next = nextCronFire('0 9 * * *', base.getTime())

    expect(next).not.toBeNull()
    const d = new Date(next!)
    // Cron fires in local time
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(0)
    // Should be next day since 09:00 already passed
    expect(d.getDate()).toBe(base.getDate() + 1)
  })

  it('should handle day-of-week filter', () => {
    // "weekdays at 09:00" → 0 9 * * 1-5
    // 2025-06-01 is a Sunday
    const base = new Date('2025-06-01T00:00:00Z').getTime()
    const next = nextCronFire('0 9 * * 1-5', base)

    expect(next).not.toBeNull()
    const d = new Date(next!)
    const dow = d.getUTCDay()
    expect(dow).toBeGreaterThanOrEqual(1)
    expect(dow).toBeLessThanOrEqual(5)
  })

  it('should handle step notation', () => {
    // "every 15 minutes" → */15 * * * *
    const base = new Date('2025-06-01T10:07:00Z').getTime()
    const next = nextCronFire('*/15 * * * *', base)

    expect(next).not.toBeNull()
    const d = new Date(next!)
    expect(d.getMinutes() % 15).toBe(0)
  })

  it('should return null for invalid expressions', () => {
    expect(nextCronFire('bad', 0)).toBeNull()
    expect(nextCronFire('* * *', 0)).toBeNull() // too few fields
  })
})

describe('createCronEngine', () => {
  it('should add and list jobs', async () => {
    const onWake = vi.fn()
    const engine = createCronEngine({ config: testConfig(), onWake })

    await engine.start()

    const id = await engine.add({
      name: 'Check portfolio',
      schedule: { kind: 'every', every: '1h' },
      payload: 'Time to check your portfolio',
    })

    const jobs = await engine.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(id)
    expect(jobs[0].name).toBe('Check portfolio')
    expect(jobs[0].enabled).toBe(true)
    expect(jobs[0].sessionTarget).toBe('main')

    engine.stop()
  })

  it('should persist jobs to disk', async () => {
    const config = testConfig()
    const onWake = vi.fn()
    const engine = createCronEngine({ config, onWake })

    await engine.start()
    await engine.add({
      name: 'Test job',
      schedule: { kind: 'every', every: '30m' },
      payload: 'test',
    })
    engine.stop()

    // Read the file directly
    const raw = await readFile(config.storePath, 'utf-8')
    const store = JSON.parse(raw)
    expect(store.jobs).toHaveLength(1)
    expect(store.jobs[0].name).toBe('Test job')
  })

  it('should update jobs', async () => {
    const onWake = vi.fn()
    const engine = createCronEngine({ config: testConfig(), onWake })

    await engine.start()

    const id = await engine.add({
      name: 'Original',
      schedule: { kind: 'every', every: '1h' },
      payload: 'original',
    })

    await engine.update(id, { name: 'Updated', payload: 'new content' })

    const job = await engine.get(id)
    expect(job?.name).toBe('Updated')
    expect(job?.payload).toBe('new content')

    engine.stop()
  })

  it('should remove jobs', async () => {
    const onWake = vi.fn()
    const engine = createCronEngine({ config: testConfig(), onWake })

    await engine.start()

    const id = await engine.add({
      name: 'To delete',
      schedule: { kind: 'every', every: '1h' },
      payload: 'delete me',
    })

    await engine.remove(id)

    const jobs = await engine.list()
    expect(jobs).toHaveLength(0)

    engine.stop()
  })

  it('should throw on update/remove for nonexistent job', async () => {
    const onWake = vi.fn()
    const engine = createCronEngine({ config: testConfig(), onWake })

    await engine.start()

    await expect(engine.update('nonexistent', { name: 'x' })).rejects.toThrow('not found')
    await expect(engine.remove('nonexistent')).rejects.toThrow('not found')

    engine.stop()
  })

  it('should execute job and inject system event + call onWake', async () => {
    const onWake = vi.fn()
    const engine = createCronEngine({ config: testConfig(), onWake })

    await engine.start()

    const id = await engine.add({
      name: 'Portfolio check',
      schedule: { kind: 'every', every: '1h' },
      payload: 'Check your BTC position',
    })

    // Manually run the job
    await engine.runNow(id)

    // Should have injected system event
    const events = drainSystemEvents()
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('cron')
    expect(events[0].text).toBe('Check your BTC position')

    // Should have called onWake
    expect(onWake).toHaveBeenCalledWith('cron')

    // Job state should be updated
    const job = await engine.get(id)
    expect(job?.state.lastStatus).toBe('ok')
    expect(job?.state.lastRunAtMs).not.toBeNull()

    engine.stop()
  })

  it('should disable one-shot (at) jobs after execution', async () => {
    const onWake = vi.fn()
    const engine = createCronEngine({ config: testConfig(), onWake })

    await engine.start()

    const id = await engine.add({
      name: 'One-time alert',
      schedule: { kind: 'at', at: new Date(Date.now() + 3600_000).toISOString() },
      payload: 'Check this once',
    })

    await engine.runNow(id)

    const job = await engine.get(id)
    expect(job?.enabled).toBe(false)
    expect(job?.state.nextRunAtMs).toBeNull()

    engine.stop()
  })

  it('should apply error backoff on consecutive failures', async () => {
    const onWake = vi.fn(() => { throw new Error('delivery failed') })
    const engine = createCronEngine({ config: testConfig(), onWake })

    await engine.start()

    const id = await engine.add({
      name: 'Failing job',
      schedule: { kind: 'every', every: '10m' },
      payload: 'will fail',
    })

    const jobBefore = await engine.get(id)
    const nextRunBefore = jobBefore?.state.nextRunAtMs

    await engine.runNow(id)

    const jobAfter = await engine.get(id)
    expect(jobAfter?.state.lastStatus).toBe('error')
    expect(jobAfter?.state.consecutiveErrors).toBe(1)
    // Next run should be pushed out by backoff (30s for first error)
    expect(jobAfter?.state.nextRunAtMs).toBeGreaterThan(Date.now())

    engine.stop()
  })

  it('should recover jobs from disk on restart', async () => {
    const config = testConfig()
    const onWake = vi.fn()

    // First run: create a job
    const engine1 = createCronEngine({ config, onWake })
    await engine1.start()
    await engine1.add({
      name: 'Persistent job',
      schedule: { kind: 'every', every: '2h' },
      payload: 'I persist',
    })
    engine1.stop()

    // Second run: should load from disk
    const engine2 = createCronEngine({ config, onWake })
    await engine2.start()

    const jobs = await engine2.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].name).toBe('Persistent job')

    engine2.stop()
  })

  it('should handle isolated session target with callback', async () => {
    const onWake = vi.fn()
    const onIsolatedRun = vi.fn(async (_job: CronJob) => {})
    const engine = createCronEngine({ config: testConfig(), onWake, onIsolatedRun })

    await engine.start()

    const id = await engine.add({
      name: 'Isolated task',
      schedule: { kind: 'every', every: '1h' },
      sessionTarget: 'isolated',
      payload: 'Run in isolation',
    })

    await engine.runNow(id)

    // Should NOT call onWake (isolated doesn't wake main session)
    expect(onWake).not.toHaveBeenCalled()
    // Should call isolated handler
    expect(onIsolatedRun).toHaveBeenCalledOnce()
    expect(onIsolatedRun).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Isolated task' }),
    )

    engine.stop()
  })
})
