/**
 * Cron — file-driven job scheduler.
 *
 * Design lineage: OpenClaw cron/service/timer.ts, simplified.
 *
 * Three schedule types:
 *   - at:    one-shot, ISO timestamp ("2025-03-01T09:00:00Z")
 *   - every: interval ("2h", "30m")
 *   - cron:  cron expression ("0 9 * * 1-5")
 *
 * Two session targets:
 *   - main:     inject system event → scheduler wakes agent in normal context
 *   - isolated:  (reserved) run agent in a fresh session
 *
 * Jobs are stored as a single JSON file on disk. The timer loop wakes at
 * the next due time (clamped to 60s to prevent drift).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { enqueueSystemEvent } from './agent-events.js'

// ==================== Types ====================

export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; every: string }
  | { kind: 'cron'; cron: string }

export type SessionTarget = 'main' | 'isolated'

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  schedule: CronSchedule
  sessionTarget: SessionTarget
  /** The text/reminder content delivered to the agent. */
  payload: string
  /** Runtime state managed by the scheduler. */
  state: CronJobState
  createdAt: number
}

export interface CronJobState {
  nextRunAtMs: number | null
  lastRunAtMs: number | null
  lastStatus: 'ok' | 'error' | 'skipped' | null
  lastError: string | null
  consecutiveErrors: number
}

export interface CronStore {
  jobs: CronJob[]
}

export interface CronConfig {
  enabled: boolean
  /** Path to the cron store JSON file. */
  storePath: string
}

// ==================== Job CRUD ====================

export type CronJobCreate = {
  name: string
  schedule: CronSchedule
  sessionTarget?: SessionTarget
  payload: string
  enabled?: boolean
}

export type CronJobPatch = {
  name?: string
  schedule?: CronSchedule
  sessionTarget?: SessionTarget
  payload?: string
  enabled?: boolean
}

// ==================== Cron Expression Parsing ====================

/**
 * Minimal cron expression parser (minute hour dom month dow).
 * Returns the next fire time after `afterMs`, or null if unparseable.
 *
 * Supports: numbers, ranges (1-5), step (0/15), wildcard (*), lists (1,3,5).
 * Does NOT support: L, W, #, ?, or second-level fields.
 */
export function nextCronFire(expr: string, afterMs: number): number | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const fields = parts.map(parseField)
  if (fields.some((f) => f === null)) return null

  const [minutes, hours, doms, months, dows] = fields as number[][]

  // Brute-force search: start from afterMs, check every minute up to 366 days out
  const start = new Date(afterMs)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1) // always at least 1 minute in the future

  const limit = afterMs + 366 * 24 * 60 * 60 * 1000
  const cursor = new Date(start)

  while (cursor.getTime() < limit) {
    const month = cursor.getMonth() + 1  // 1-12
    const dom = cursor.getDate()          // 1-31
    const dow = cursor.getDay()           // 0-6 (Sun=0)
    const hour = cursor.getHours()
    const minute = cursor.getMinutes()

    if (
      months.includes(month) &&
      doms.includes(dom) &&
      dows.includes(dow) &&
      hours.includes(hour) &&
      minutes.includes(minute)
    ) {
      return cursor.getTime()
    }

    cursor.setMinutes(cursor.getMinutes() + 1)
  }

  return null
}

function parseField(field: string): number[] | null {
  const rangeMap: Record<number, [number, number]> = {
    0: [0, 59],   // minute
    1: [0, 23],   // hour
    2: [1, 31],   // dom
    3: [1, 12],   // month
    4: [0, 6],    // dow
  }
  // This is called per-field but we don't know which field index.
  // We'll parse generically and let nextCronFire validate.
  return parseFieldValues(field)
}

function parseFieldValues(field: string): number[] | null {
  const result: number[] = []

  for (const part of field.split(',')) {
    // Step: */5 or 0-30/5
    const stepMatch = /^(\*|\d+-\d+)\/(\d+)$/.exec(part)
    if (stepMatch) {
      const step = Number(stepMatch[2])
      if (step === 0) return null
      let start: number, end: number
      if (stepMatch[1] === '*') {
        start = 0; end = 59  // will be bounded by field context
      } else {
        const [a, b] = stepMatch[1].split('-').map(Number)
        start = a; end = b
      }
      for (let i = start; i <= end; i += step) result.push(i)
      continue
    }

    // Range: 1-5
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part)
    if (rangeMatch) {
      const a = Number(rangeMatch[1])
      const b = Number(rangeMatch[2])
      for (let i = a; i <= b; i++) result.push(i)
      continue
    }

    // Wildcard
    if (part === '*') {
      // Return all possible values — caller determines the valid range
      for (let i = 0; i <= 59; i++) result.push(i)
      continue
    }

    // Single number
    const n = Number(part)
    if (Number.isNaN(n)) return null
    result.push(n)
  }

  return result.length > 0 ? result : null
}

// ==================== Duration Parsing (shared with scheduler) ====================

function parseDuration(s: string): number | null {
  const re = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/
  const m = re.exec(s.trim())
  if (!m) return null
  const h = Number(m[1] ?? 0)
  const min = Number(m[2] ?? 0)
  const sec = Number(m[3] ?? 0)
  if (h === 0 && min === 0 && sec === 0) return null
  return (h * 3600 + min * 60 + sec) * 1000
}

// ==================== Next Run Computation ====================

function computeNextRun(schedule: CronSchedule, afterMs: number): number | null {
  switch (schedule.kind) {
    case 'at': {
      const t = new Date(schedule.at).getTime()
      return Number.isNaN(t) ? null : (t > afterMs ? t : null)
    }
    case 'every': {
      const ms = parseDuration(schedule.every)
      return ms ? afterMs + ms : null
    }
    case 'cron':
      return nextCronFire(schedule.cron, afterMs)
  }
}

// ==================== Error Backoff ====================

const ERROR_BACKOFF_MS = [
  30_000,     // 30s
  60_000,     // 1m
  300_000,    // 5m
  900_000,    // 15m
  3_600_000,  // 60m
] as const

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)
  return ERROR_BACKOFF_MS[Math.max(0, idx)]
}

// ==================== File Store ====================

async function loadStore(path: string): Promise<CronStore> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as CronStore
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { jobs: [] }
    }
    throw err
  }
}

async function saveStore(path: string, store: CronStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8')
  // Atomic rename
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

// ==================== Cron Engine ====================

export interface CronEngine {
  /** Start the timer loop. */
  start(): void
  /** Stop the timer loop. */
  stop(): void
  /** Add a new job. Returns the job id. */
  add(params: CronJobCreate): Promise<string>
  /** Update an existing job. */
  update(id: string, patch: CronJobPatch): Promise<void>
  /** Remove a job. */
  remove(id: string): Promise<void>
  /** List all jobs. */
  list(): Promise<CronJob[]>
  /** Manually run a job now (bypass schedule). */
  runNow(id: string): Promise<void>
  /** Get a single job by id. */
  get(id: string): Promise<CronJob | undefined>
}

export interface CronEngineOpts {
  config: CronConfig
  /** Called when a main-session job fires. Scheduler should wake the agent. */
  onWake: (reason: 'cron') => void
  /** Called when an isolated job fires. Reserved for future use. */
  onIsolatedRun?: (job: CronJob) => Promise<void>
  /** Inject clock for testing. */
  now?: () => number
}

export function createCronEngine(opts: CronEngineOpts): CronEngine {
  const { config, onWake, onIsolatedRun } = opts
  const now = opts.now ?? Date.now

  let store: CronStore = { jobs: [] }
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function load(): Promise<void> {
    store = await loadStore(config.storePath)
  }

  async function save(): Promise<void> {
    await saveStore(config.storePath, store)
  }

  function findJob(id: string): CronJob | undefined {
    return store.jobs.find((j) => j.id === id)
  }

  /** Arm the next timer. Clamp to 60s max to prevent long setTimeout drift. */
  function armTimer(): void {
    if (stopped) return

    const nextMs = store.jobs
      .filter((j) => j.enabled && j.state.nextRunAtMs !== null)
      .reduce<number | null>((min, j) => {
        const n = j.state.nextRunAtMs!
        return min === null ? n : Math.min(min, n)
      }, null)

    if (nextMs === null) return

    const delayMs = Math.max(0, Math.min(nextMs - now(), 60_000))
    console.log(`cron: armed timer, next fire in ${Math.round(delayMs / 1000)}s`)
    timer = setTimeout(onTick, delayMs)
  }

  async function onTick(): Promise<void> {
    timer = null
    if (stopped) return

    const currentMs = now()
    const dueJobs = store.jobs.filter(
      (j) => j.enabled && j.state.nextRunAtMs !== null && j.state.nextRunAtMs <= currentMs,
    )

    console.log(`cron: tick — ${dueJobs.length} due job(s)${dueJobs.length > 0 ? ': ' + dueJobs.map((j) => j.name).join(', ') : ''}`)

    for (const job of dueJobs) {
      await executeJob(job, currentMs)
    }

    if (!stopped) {
      await save()
      armTimer()
    }
  }

  async function executeJob(job: CronJob, currentMs: number): Promise<void> {
    console.log(`cron: executing job "${job.name}" [${job.id}] target=${job.sessionTarget}`)
    job.state.lastRunAtMs = currentMs

    try {
      if (job.sessionTarget === 'main') {
        // Inject system event for the agent to pick up
        enqueueSystemEvent({
          id: `cron:${job.id}:${currentMs}`,
          source: 'cron',
          text: job.payload,
          contextKey: `cron:${job.id}`,
        })
        console.log(`cron: system event enqueued, calling onWake('cron')`)
        onWake('cron')
      } else if (job.sessionTarget === 'isolated' && onIsolatedRun) {
        await onIsolatedRun(job)
      }

      job.state.lastStatus = 'ok'
      job.state.lastError = null
      job.state.consecutiveErrors = 0

    } catch (err) {
      job.state.lastStatus = 'error'
      job.state.lastError = err instanceof Error ? err.message : String(err)
      job.state.consecutiveErrors += 1
    }

    // Compute next run
    if (job.schedule.kind === 'at') {
      // One-shot — disable after any execution
      job.enabled = false
      job.state.nextRunAtMs = null
    } else if (job.state.consecutiveErrors > 0) {
      // Error backoff
      job.state.nextRunAtMs = currentMs + errorBackoffMs(job.state.consecutiveErrors)
    } else {
      job.state.nextRunAtMs = computeNextRun(job.schedule, currentMs)
    }
  }

  // ---- Public API ----

  return {
    async start() {
      await load()

      // Recompute nextRunAtMs for all enabled jobs
      const currentMs = now()
      for (const job of store.jobs) {
        if (!job.enabled) continue
        if (job.state.nextRunAtMs === null || job.state.nextRunAtMs < currentMs) {
          job.state.nextRunAtMs = computeNextRun(job.schedule, currentMs)
          // Disable expired one-shot jobs
          if (job.schedule.kind === 'at' && job.state.nextRunAtMs === null) {
            job.enabled = false
          }
        }
      }

      await save()
      armTimer()
    },

    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },

    async add(params) {
      await load()
      const id = randomUUID().slice(0, 8)
      const currentMs = now()

      const job: CronJob = {
        id,
        name: params.name,
        enabled: params.enabled ?? true,
        schedule: params.schedule,
        sessionTarget: params.sessionTarget ?? 'main',
        payload: params.payload,
        state: {
          nextRunAtMs: computeNextRun(params.schedule, currentMs),
          lastRunAtMs: null,
          lastStatus: null,
          lastError: null,
          consecutiveErrors: 0,
        },
        createdAt: currentMs,
      }

      store.jobs.push(job)
      await save()

      // Re-arm timer in case this job is sooner than current next
      if (timer) { clearTimeout(timer); timer = null }
      armTimer()

      return id
    },

    async update(id, patch) {
      await load()
      const job = findJob(id)
      if (!job) throw new Error(`cron job not found: ${id}`)

      if (patch.name !== undefined) job.name = patch.name
      if (patch.payload !== undefined) job.payload = patch.payload
      if (patch.sessionTarget !== undefined) job.sessionTarget = patch.sessionTarget
      if (patch.enabled !== undefined) job.enabled = patch.enabled

      if (patch.schedule !== undefined) {
        job.schedule = patch.schedule
        job.state.nextRunAtMs = computeNextRun(patch.schedule, now())
        job.state.consecutiveErrors = 0
      }

      await save()

      if (timer) { clearTimeout(timer); timer = null }
      armTimer()
    },

    async remove(id) {
      await load()
      const idx = store.jobs.findIndex((j) => j.id === id)
      if (idx === -1) throw new Error(`cron job not found: ${id}`)
      store.jobs.splice(idx, 1)
      await save()
    },

    async list() {
      await load()
      return [...store.jobs]
    },

    async runNow(id) {
      await load()
      const job = findJob(id)
      if (!job) throw new Error(`cron job not found: ${id}`)
      await executeJob(job, now())
      await save()
    },

    async get(id) {
      await load()
      return findJob(id)
    },
  }
}
