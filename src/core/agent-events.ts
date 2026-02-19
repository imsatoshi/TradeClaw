/**
 * Agent Event Bus — unified event backbone for the scheduling subsystem.
 *
 * Design lineage: OpenClaw agent-events + system-events, merged and simplified.
 *
 * All scheduling primitives (heartbeat, cron, connectors) communicate through
 * this bus. Events are in-memory, ephemeral, synchronous fan-out. No persistence
 * — that's delivery.ts's job.
 *
 * Stream taxonomy:
 *   lifecycle  — agent run start/stop/error
 *   heartbeat  — heartbeat poll results (ok/skipped/failed)
 *   cron       — cron job execution results
 *   message    — inbound user messages from connectors
 *   system     — injected events (cron reminders, wake triggers)
 *   delivery   — outbound delivery status
 */

// ==================== Types ====================

/** Well-known event streams. Extensible via string. */
export type EventStream =
  | 'lifecycle'
  | 'heartbeat'
  | 'cron'
  | 'message'
  | 'system'
  | 'delivery'
  | (string & {})

export interface AgentEvent<T = Record<string, unknown>> {
  /** Auto-assigned monotonic sequence number (per-stream). */
  seq: number
  /** Event timestamp (epoch ms). */
  ts: number
  /** Which stream this event belongs to. */
  stream: EventStream
  /** Arbitrary payload. */
  data: T
}

export type EventListener<T = Record<string, unknown>> = (event: AgentEvent<T>) => void

// ==================== System Event Queue ====================

/**
 * Lightweight system event queue for cron→agent communication.
 *
 * Cron jobs inject events here; the scheduler drains them when waking
 * the agent, building them into the prompt context.
 *
 * Bounded (default 50), oldest-first eviction. No persistence — if the
 * process dies, pending system events are lost (cron will re-fire).
 */
export interface SystemEvent {
  id: string
  ts: number
  source: 'cron' | 'manual' | 'hook'
  text: string
  /** Optional dedup key — events with the same key replace each other. */
  contextKey?: string
}

// ==================== Implementation ====================

const seqByStream = new Map<string, number>()
const listeners = new Set<EventListener<any>>()
const streamListeners = new Map<string, Set<EventListener<any>>>()

/** Global system event queue. */
let systemQueue: SystemEvent[] = []
const SYSTEM_QUEUE_MAX = 50

function nextSeq(stream: string): number {
  const n = (seqByStream.get(stream) ?? 0) + 1
  seqByStream.set(stream, n)
  return n
}

// ==================== Event Bus API ====================

/** Emit an event to all listeners (global + stream-specific). */
export function emit<T = Record<string, unknown>>(
  stream: EventStream,
  data: T,
): AgentEvent<T> {
  const event: AgentEvent<T> = {
    seq: nextSeq(stream),
    ts: Date.now(),
    stream,
    data,
  }

  for (const fn of listeners) {
    try { fn(event) } catch { /* listener errors are silently swallowed */ }
  }

  const streamSet = streamListeners.get(stream)
  if (streamSet) {
    for (const fn of streamSet) {
      try { fn(event) } catch { /* swallow */ }
    }
  }

  return event
}

/** Subscribe to all events. Returns an unsubscribe function. */
export function on<T = Record<string, unknown>>(listener: EventListener<T>): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Subscribe to events on a specific stream. Returns an unsubscribe function. */
export function onStream<T = Record<string, unknown>>(
  stream: EventStream,
  listener: EventListener<T>,
): () => void {
  let set = streamListeners.get(stream)
  if (!set) {
    set = new Set()
    streamListeners.set(stream, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) streamListeners.delete(stream)
  }
}

// ==================== System Event Queue API ====================

/** Enqueue a system event (cron reminder, manual wake, etc.). */
export function enqueueSystemEvent(event: Omit<SystemEvent, 'ts'>): void {
  // Dedup by contextKey — replace existing event with same key
  if (event.contextKey) {
    const idx = systemQueue.findIndex((e) => e.contextKey === event.contextKey)
    if (idx !== -1) {
      systemQueue[idx] = { ...event, ts: Date.now() }
      return
    }
  }

  systemQueue.push({ ...event, ts: Date.now() })

  // Evict oldest if over capacity
  if (systemQueue.length > SYSTEM_QUEUE_MAX) {
    systemQueue = systemQueue.slice(-SYSTEM_QUEUE_MAX)
  }
}

/** Drain all pending system events (returns and clears the queue). */
export function drainSystemEvents(): SystemEvent[] {
  const events = systemQueue
  systemQueue = []
  return events
}

/** Peek at pending system events without draining. */
export function peekSystemEvents(): readonly SystemEvent[] {
  return systemQueue
}

/** Check if there are pending system events. */
export function hasSystemEvents(): boolean {
  return systemQueue.length > 0
}

// ==================== Testing Utilities ====================

/** Reset all state — only for tests. */
export function _resetForTest(): void {
  seqByStream.clear()
  listeners.clear()
  streamListeners.clear()
  systemQueue = []
}
