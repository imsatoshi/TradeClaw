import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCronTools } from './adapter.js'
import type { CronEngine, CronJob } from '../../core/cron.js'

// ==================== Mock CronEngine ====================

function makeMockCronEngine(): CronEngine & { _jobs: CronJob[] } {
  const jobs: CronJob[] = []

  const engine: CronEngine & { _jobs: CronJob[] } = {
    _jobs: jobs,
    start: vi.fn(),
    stop: vi.fn(),
    add: vi.fn(async (params) => {
      const id = `mock-${jobs.length + 1}`
      const job: CronJob = {
        id,
        name: params.name,
        enabled: params.enabled ?? true,
        schedule: params.schedule,
        sessionTarget: params.sessionTarget ?? 'main',
        payload: params.payload,
        state: {
          nextRunAtMs: Date.now() + 3600_000,
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          consecutiveErrors: 0,
        },
        createdAt: Date.now(),
      }
      jobs.push(job)
      return id
    }),
    update: vi.fn(async (id, patch) => {
      const job = jobs.find((j) => j.id === id)
      if (!job) throw new Error(`cron job not found: ${id}`)
      if (patch.name !== undefined) job.name = patch.name
      if (patch.payload !== undefined) job.payload = patch.payload
      if (patch.enabled !== undefined) job.enabled = patch.enabled
    }),
    remove: vi.fn(async (id) => {
      const idx = jobs.findIndex((j) => j.id === id)
      if (idx === -1) throw new Error(`cron job not found: ${id}`)
      jobs.splice(idx, 1)
    }),
    list: vi.fn(async () => [...jobs]),
    runNow: vi.fn(async (id) => {
      const job = jobs.find((j) => j.id === id)
      if (!job) throw new Error(`cron job not found: ${id}`)
      job.state.lastRunAtMs = Date.now()
      job.state.lastStatus = 'ok'
    }),
    get: vi.fn(async (id) => jobs.find((j) => j.id === id)),
  }

  return engine
}

// ==================== Tests ====================

describe('createCronTools', () => {
  let engine: ReturnType<typeof makeMockCronEngine>
  let tools: ReturnType<typeof createCronTools>

  beforeEach(() => {
    engine = makeMockCronEngine()
    tools = createCronTools(engine)
  })

  it('should expose all five tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'cronAdd', 'cronList', 'cronRemove', 'cronRunNow', 'cronUpdate',
    ])
  })

  // ---- cronList ----

  describe('cronList', () => {
    it('should return empty list when no jobs', async () => {
      const result = await tools.cronList.execute!({}, { toolCallId: 't1', messages: [], abortSignal: AbortSignal.timeout(5000) })
      expect(result).toEqual({ jobs: [] })
    })

    it('should return jobs after adding', async () => {
      await tools.cronAdd.execute!(
        { name: 'Test', schedule: { kind: 'every', every: '1h' }, payload: 'hello' },
        { toolCallId: 't2', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      const result = await tools.cronList.execute!({}, { toolCallId: 't3', messages: [], abortSignal: AbortSignal.timeout(5000) })
      expect((result as { jobs: CronJob[] }).jobs).toHaveLength(1)
      expect((result as { jobs: CronJob[] }).jobs[0].name).toBe('Test')
    })
  })

  // ---- cronAdd ----

  describe('cronAdd', () => {
    it('should create a job with "every" schedule', async () => {
      const result = await tools.cronAdd.execute!(
        { name: 'Hourly check', schedule: { kind: 'every', every: '1h' }, payload: 'Check BTC' },
        { toolCallId: 't4', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      expect((result as { id: string }).id).toBe('mock-1')
      expect(engine.add).toHaveBeenCalledOnce()
    })

    it('should create a job with "cron" schedule', async () => {
      const result = await tools.cronAdd.execute!(
        { name: 'Morning brief', schedule: { kind: 'cron', cron: '0 9 * * 1-5' }, payload: 'Market brief' },
        { toolCallId: 't5', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      expect((result as { id: string }).id).toBe('mock-1')
      expect((result as { job: CronJob }).job?.schedule).toEqual({ kind: 'cron', cron: '0 9 * * 1-5' })
    })

    it('should create a job with "at" schedule', async () => {
      const result = await tools.cronAdd.execute!(
        { name: 'One-shot', schedule: { kind: 'at', at: '2025-12-01T00:00:00Z' }, payload: 'Fire once' },
        { toolCallId: 't6', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      expect((result as { job: CronJob }).job?.schedule.kind).toBe('at')
    })

    it('should pass sessionTarget and enabled to engine', async () => {
      await tools.cronAdd.execute!(
        {
          name: 'Isolated job',
          schedule: { kind: 'every', every: '30m' },
          payload: 'test',
          sessionTarget: 'isolated',
          enabled: false,
        },
        { toolCallId: 't7', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      expect(engine.add).toHaveBeenCalledWith(expect.objectContaining({
        sessionTarget: 'isolated',
        enabled: false,
      }))
    })
  })

  // ---- cronUpdate ----

  describe('cronUpdate', () => {
    it('should update a job', async () => {
      await tools.cronAdd.execute!(
        { name: 'Old name', schedule: { kind: 'every', every: '1h' }, payload: 'old' },
        { toolCallId: 't8', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      const result = await tools.cronUpdate.execute!(
        { id: 'mock-1', name: 'New name', payload: 'new' },
        { toolCallId: 't9', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      expect((result as { updated: boolean }).updated).toBe(true)
      expect((result as { job: CronJob }).job?.name).toBe('New name')
      expect((result as { job: CronJob }).job?.payload).toBe('new')
    })

    it('should throw for unknown job id', async () => {
      await expect(
        tools.cronUpdate.execute!(
          { id: 'nonexistent', name: 'x' },
          { toolCallId: 't10', messages: [], abortSignal: AbortSignal.timeout(5000) },
        ),
      ).rejects.toThrow('cron job not found')
    })
  })

  // ---- cronRemove ----

  describe('cronRemove', () => {
    it('should remove a job', async () => {
      await tools.cronAdd.execute!(
        { name: 'To delete', schedule: { kind: 'every', every: '1h' }, payload: 'x' },
        { toolCallId: 't11', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      const result = await tools.cronRemove.execute!(
        { id: 'mock-1' },
        { toolCallId: 't12', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      expect((result as { removed: boolean }).removed).toBe(true)
      expect(engine._jobs).toHaveLength(0)
    })

    it('should throw for unknown job id', async () => {
      await expect(
        tools.cronRemove.execute!(
          { id: 'nonexistent' },
          { toolCallId: 't13', messages: [], abortSignal: AbortSignal.timeout(5000) },
        ),
      ).rejects.toThrow('cron job not found')
    })
  })

  // ---- cronRunNow ----

  describe('cronRunNow', () => {
    it('should trigger a job manually', async () => {
      await tools.cronAdd.execute!(
        { name: 'Manual trigger', schedule: { kind: 'every', every: '24h' }, payload: 'run me' },
        { toolCallId: 't14', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      const result = await tools.cronRunNow.execute!(
        { id: 'mock-1' },
        { toolCallId: 't15', messages: [], abortSignal: AbortSignal.timeout(5000) },
      )
      expect((result as { triggered: boolean }).triggered).toBe(true)
      expect((result as { job: CronJob }).job?.state.lastStatus).toBe('ok')
      expect(engine.runNow).toHaveBeenCalledWith('mock-1')
    })

    it('should throw for unknown job id', async () => {
      await expect(
        tools.cronRunNow.execute!(
          { id: 'nonexistent' },
          { toolCallId: 't16', messages: [], abortSignal: AbortSignal.timeout(5000) },
        ),
      ).rejects.toThrow('cron job not found')
    })
  })
})
