/**
 * Scheduler — heartbeat scheduling + wake coalescing + active hours.
 *
 * Design lineage: OpenClaw heartbeat-runner + heartbeat-wake + heartbeat-active-hours,
 * unified into a single coherent module.
 *
 * Core idea: the scheduler is the agent's "alarm clock". It periodically wakes
 * the agent to check on things (heartbeat), and external sources (cron, manual,
 * connectors) can request immediate wakes. Multiple wake requests within a short
 * window are coalesced — highest priority wins.
 *
 * The scheduler does NOT own the agent execution — it calls a provided `runOnce`
 * callback. This keeps it decoupled from Engine internals.
 */

import { readFile } from 'node:fs/promises'
import { emit, drainSystemEvents, enqueueSystemEvent, hasSystemEvents } from './agent-events.js'

// ==================== Types ====================

export interface SchedulerConfig {
  heartbeat: {
    enabled: boolean
    /** Interval between heartbeat polls, e.g. "30m", "1h", "5m". */
    every: string
    /** Prompt sent to the agent on heartbeat. */
    prompt: string
    /** Token the agent can return to signal "nothing to report". */
    ackToken: string
    /** Max chars for a response to be considered a short ack (suppressed). */
    ackMaxChars: number
    /** Active hours window. Null = always active. */
    activeHours: {
      start: string  // "HH:MM"
      end: string    // "HH:MM"
      timezone: string  // IANA timezone or "local"
    } | null
  }
}

export interface HeartbeatResult {
  status: 'sent' | 'ok-empty' | 'ok-ack' | 'skipped' | 'failed'
  reason?: string
  text?: string
  durationMs?: number
}

/** Priority levels for wake requests. Higher number = higher priority. */
export type WakeReason =
  | 'retry'       // 0 — automatic retry after transient failure
  | 'interval'    // 1 — regular heartbeat tick
  | 'cron'        // 2 — cron job fired
  | 'message'     // 2 — inbound user message
  | 'manual'      // 3 — explicit manual trigger
  | 'hook'        // 3 — external webhook / integration

const WAKE_PRIORITY: Record<WakeReason, number> = {
  retry: 0,
  interval: 1,
  cron: 2,
  message: 2,
  manual: 3,
  hook: 3,
}

export type RunOnce = (opts: {
  reason: WakeReason
  prompt: string
  systemEvents: Array<{ id: string; source: string; text: string }>
}) => Promise<HeartbeatResult>

export interface Scheduler {
  /** Request an immediate wake (coalesced with pending requests). */
  requestWake(reason?: WakeReason): void
  /** Stop the scheduler (clears all timers). */
  stop(): void
  /** Check if a wake is pending. */
  hasPendingWake(): boolean
}

// ==================== Active Hours ====================

/**
 * Check if the current time falls within the active hours window.
 * Returns true if no activeHours configured (always active).
 */
export function isWithinActiveHours(
  activeHours: SchedulerConfig['heartbeat']['activeHours'],
  nowMs?: number,
): boolean {
  if (!activeHours) return true

  const { start, end, timezone } = activeHours

  const startMinutes = parseHHMM(start)
  const endMinutes = parseHHMM(end)
  if (startMinutes === null || endMinutes === null) return true // parse failure → always active

  const nowMinutes = currentMinutesInTimezone(timezone, nowMs)

  // Normal range (e.g. 09:00 → 22:00)
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes
  }

  // Overnight range (e.g. 22:00 → 06:00)
  return nowMinutes >= startMinutes || nowMinutes < endMinutes
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59) return null
  return h * 60 + min
}

function currentMinutesInTimezone(tz: string, nowMs?: number): number {
  const now = nowMs ? new Date(nowMs) : new Date()

  if (tz === 'local') {
    return now.getHours() * 60 + now.getMinutes()
  }

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })
    const parts = fmt.formatToParts(now)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    return hour * 60 + minute
  } catch {
    // Invalid timezone → fallback to local
    return now.getHours() * 60 + now.getMinutes()
  }
}

// ==================== Duration Parsing ====================

/** Parse a human duration string like "30m", "1h", "5m30s" into milliseconds. */
export function parseDuration(s: string): number | null {
  const re = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/
  const m = re.exec(s.trim())
  if (!m) return null
  const h = Number(m[1] ?? 0)
  const min = Number(m[2] ?? 0)
  const sec = Number(m[3] ?? 0)
  if (h === 0 && min === 0 && sec === 0) return null
  return (h * 3600 + min * 60 + sec) * 1000
}

// ==================== Ack Token Stripping ====================

export interface StripResult {
  /** Should the heartbeat response be suppressed (not delivered)? */
  shouldSkip: boolean
  /** Cleaned text with ack tokens removed. */
  text: string
}

/**
 * Strip the ack token from an agent response.
 *
 * If the response is just the ack token (possibly with minor wrapping),
 * or the remaining text after stripping is under ackMaxChars, it's
 * considered "nothing to report" and shouldSkip = true.
 */
export function stripAckToken(
  raw: string,
  ackToken: string,
  ackMaxChars: number,
): StripResult {
  if (!raw.trim()) return { shouldSkip: true, text: '' }

  // Remove all occurrences of the ack token (case-insensitive, with optional wrapping)
  const escaped = ackToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?:\\*{0,2}|<[^>]+>)?\\s*${escaped}\\s*(?:\\*{0,2}|<\\/[^>]+>)?`,
    'gi',
  )

  const stripped = raw.replace(pattern, '').trim()

  if (!stripped) return { shouldSkip: true, text: '' }

  // Short remaining text after stripping → treat as ack noise
  if (stripped.length <= ackMaxChars && raw.includes(ackToken)) {
    return { shouldSkip: true, text: stripped }
  }

  return { shouldSkip: false, text: stripped || raw }
}

// ==================== Heartbeat File Check ====================

/**
 * Check whether a HEARTBEAT.md file's content is "effectively empty" —
 * meaning it only contains whitespace, markdown headers, and/or empty list items.
 *
 * When the file is effectively empty, heartbeat should skip the API call
 * to save tokens (the model has nothing to check).
 *
 * Only applies to interval/retry ticks. Cron, manual, and hook wakes always run.
 */
export function isHeartbeatFileEmpty(content: string): boolean {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue                          // blank line
    if (/^#+\s/.test(trimmed)) continue             // markdown header
    if (/^<!--.*-->$/.test(trimmed)) continue        // HTML comment (single-line)
    if (/^[-*]\s*$/.test(trimmed)) continue          // empty list item ("- " or "* ")
    return false                                     // actual content found
  }
  return true
}

/**
 * Try to read a heartbeat file from disk.
 * Returns the content string, or null if the file doesn't exist.
 */
export async function readHeartbeatFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/** Reasons that bypass the empty-file guard (non-interval triggers). */
function isHighPriorityReason(reason: WakeReason): boolean {
  return reason === 'cron' || reason === 'manual' || reason === 'hook'
}

// ==================== Dedup ====================

/**
 * Simple deduplication: suppress identical heartbeat messages within a window.
 *
 * Tracks the last delivered text and timestamp. If the same text was sent
 * within `windowMs` (default 24h), returns true (should skip).
 */
export class HeartbeatDedup {
  private lastText: string | null = null
  private lastSentAt = 0
  private windowMs: number

  constructor(windowMs = 24 * 60 * 60 * 1000) {
    this.windowMs = windowMs
  }

  /** Returns true if this text is a duplicate (same content sent within window). */
  isDuplicate(text: string, nowMs = Date.now()): boolean {
    if (this.lastText === null) return false
    if (text !== this.lastText) return false
    return (nowMs - this.lastSentAt) < this.windowMs
  }

  /** Record a successful delivery. */
  record(text: string, nowMs = Date.now()): void {
    this.lastText = text
    this.lastSentAt = nowMs
  }
}

// ==================== Scheduler ====================

const DEFAULT_COALESCE_MS = 250
const RETRY_DELAY_MS = 1000

export function createScheduler(
  config: SchedulerConfig,
  runOnce: RunOnce,
  opts?: {
    /** Override coalesce window for testing. */
    coalesceMs?: number
    /** Inject clock for testing. */
    now?: () => number
  },
): Scheduler {
  const coalesceMs = opts?.coalesceMs ?? DEFAULT_COALESCE_MS
  const now = opts?.now ?? Date.now

  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let stopped = false

  // Wake coalescing state
  let pendingReason: WakeReason | null = null
  let pendingPriority = -1

  function requestWake(reason: WakeReason = 'manual'): void {
    if (stopped) return

    const priority = WAKE_PRIORITY[reason] ?? 2

    // Higher priority preempts — or first request starts the coalesce window
    if (pendingReason === null || priority > pendingPriority) {
      pendingReason = reason
      pendingPriority = priority
    }

    // Start coalesce timer if not already running
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(flush, coalesceMs)
    }
  }

  async function flush(): Promise<void> {
    coalesceTimer = null

    if (stopped) return

    // FIX(Bug 2): If a run is in progress, don't clear the pending wake.
    // Instead, schedule a re-flush after the current run might have finished.
    if (running) {
      if (pendingReason !== null) {
        console.log(`scheduler: flush deferred (running), pending=${pendingReason}`)
        setTimeout(flush, coalesceMs)
      }
      return
    }

    if (pendingReason === null) return

    const reason = pendingReason
    pendingReason = null
    pendingPriority = -1
    console.log(`scheduler: flush reason=${reason}`)

    // Active hours check (only for interval heartbeats)
    if (reason === 'interval' && !isWithinActiveHours(config.heartbeat.activeHours, now())) {
      emit('heartbeat', { status: 'skipped', reason: 'outside-active-hours' })
      return
    }

    running = true
    const start = now()

    // Drain system events (cron injections) to include in prompt.
    // Hoisted so catch can re-enqueue on failure.
    const systemEvents = hasSystemEvents() ? drainSystemEvents() : []

    try {
      const result = await runOnce({
        reason,
        prompt: config.heartbeat.prompt,
        systemEvents: systemEvents.map((e) => ({
          id: e.id,
          source: e.source,
          text: e.text,
        })),
      })

      // FIX(Bug 1): If runOnce skipped (e.g. engine-busy), re-enqueue the
      // system events so they are not lost, and schedule a retry.
      if (result.status === 'skipped' && systemEvents.length > 0) {
        for (const evt of systemEvents) {
          enqueueSystemEvent(evt)
        }
        if (!stopped) {
          setTimeout(() => requestWake('retry'), RETRY_DELAY_MS)
        }
      }

      const durationMs = now() - start
      emit('heartbeat', { ...result, reason, durationMs })

    } catch (err) {
      console.error('scheduler: runOnce error:', err)
      emit('heartbeat', {
        status: 'failed',
        reason: String(err instanceof Error ? err.message : err),
        durationMs: now() - start,
      })

      // Re-enqueue system events so they survive the retry
      if (systemEvents.length > 0) {
        for (const evt of systemEvents) {
          enqueueSystemEvent(evt)
        }
      }

      // Auto-retry on failure (lowest priority)
      if (!stopped) {
        setTimeout(() => requestWake('retry'), RETRY_DELAY_MS)
      }
    } finally {
      running = false
    }
  }

  // Start the heartbeat interval
  if (config.heartbeat.enabled) {
    const everyMs = parseDuration(config.heartbeat.every)
    if (everyMs && everyMs > 0) {
      // First tick after one interval
      intervalTimer = setInterval(() => requestWake('interval'), everyMs)
    }
  }

  return {
    requestWake,
    hasPendingWake: () => pendingReason !== null || running,
    stop() {
      stopped = true
      if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null }
    },
  }
}
