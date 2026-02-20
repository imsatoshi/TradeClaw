/**
 * Event Log — append-only persistent event log.
 *
 * All events are serialized into a single JSONL file. Consumers maintain
 * their own read offsets and can replay from any point.
 *
 * Storage: one JSON object per line (`events.jsonl`), append-only.
 * Recovery: on startup, reads the last line to restore the seq counter.
 *
 * This module is independent from `agent-events.ts` (in-memory fan-out).
 * agent-events stays for real-time ephemeral pub/sub; this is the
 * durable backbone.
 */

import { appendFile, readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

// ==================== Types ====================

export interface EventLogEntry<T = unknown> {
  /** Global monotonic sequence number. */
  seq: number
  /** Event timestamp (epoch ms). */
  ts: number
  /** Event type, e.g. "trade.open", "heartbeat.ok". */
  type: string
  /** Arbitrary JSON-serializable payload. */
  payload: T
}

export type EventLogListener = (entry: EventLogEntry) => void

export interface EventLog {
  /** Append an event. Returns the persisted entry (with seq/ts). */
  append<T>(type: string, payload: T): Promise<EventLogEntry<T>>

  /**
   * Read events from the log file.
   * - afterSeq: only return entries with seq > afterSeq (default: 0 = all)
   * - type: only return entries matching this type
   * - limit: max number of entries to return
   */
  read(opts?: { afterSeq?: number; limit?: number; type?: string }): Promise<EventLogEntry[]>

  /** Current highest seq number (0 if empty). */
  lastSeq(): number

  /** Subscribe to new events (real-time, on append). Returns unsubscribe fn. */
  subscribe(listener: EventLogListener): () => void

  /** Subscribe to new events of a specific type. Returns unsubscribe fn. */
  subscribeType(type: string, listener: EventLogListener): () => void

  /** Close the log (clear listeners). */
  close(): Promise<void>

  /** Reset all state and delete the log file. For tests only. */
  _resetForTest(): Promise<void>
}

// ==================== Implementation ====================

/**
 * Create (or open) an append-only event log.
 *
 * Reads the existing file to restore the seq counter. If the file does
 * not exist, starts fresh from seq 0.
 */
export async function createEventLog(opts?: {
  logPath?: string
}): Promise<EventLog> {
  const logPath = opts?.logPath ?? 'data/event-log/events.jsonl'

  // Ensure directory exists
  await mkdir(dirname(logPath), { recursive: true })

  // Recover last seq from existing file
  let seq = await recoverLastSeq(logPath)

  // Listener sets
  const listeners = new Set<EventLogListener>()
  const typeListeners = new Map<string, Set<EventLogListener>>()

  // ---------- append ----------

  async function append<T>(type: string, payload: T): Promise<EventLogEntry<T>> {
    seq += 1
    const entry: EventLogEntry<T> = {
      seq,
      ts: Date.now(),
      type,
      payload,
    }

    const line = JSON.stringify(entry) + '\n'
    await appendFile(logPath, line, 'utf-8')

    // Fan-out to subscribers (swallow errors)
    for (const fn of listeners) {
      try { fn(entry) } catch { /* swallow */ }
    }
    const tSet = typeListeners.get(type)
    if (tSet) {
      for (const fn of tSet) {
        try { fn(entry) } catch { /* swallow */ }
      }
    }

    return entry
  }

  // ---------- read ----------

  async function read(readOpts?: {
    afterSeq?: number
    limit?: number
    type?: string
  }): Promise<EventLogEntry[]> {
    const afterSeq = readOpts?.afterSeq ?? 0
    const limit = readOpts?.limit ?? Infinity
    const filterType = readOpts?.type

    let raw: string
    try {
      raw = await readFile(logPath, 'utf-8')
    } catch (err: unknown) {
      if (isENOENT(err)) return []
      throw err
    }

    const lines = raw.split('\n')
    const results: EventLogEntry[] = []

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry: EventLogEntry = JSON.parse(line)
        if (entry.seq <= afterSeq) continue
        if (filterType && entry.type !== filterType) continue
        results.push(entry)
        if (results.length >= limit) break
      } catch {
        // Skip malformed lines
      }
    }

    return results
  }

  // ---------- subscribe ----------

  function subscribe(listener: EventLogListener): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  function subscribeType(type: string, listener: EventLogListener): () => void {
    let set = typeListeners.get(type)
    if (!set) {
      set = new Set()
      typeListeners.set(type, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
      if (set!.size === 0) typeListeners.delete(type)
    }
  }

  // ---------- lifecycle ----------

  async function close(): Promise<void> {
    listeners.clear()
    typeListeners.clear()
  }

  async function _resetForTest(): Promise<void> {
    seq = 0
    listeners.clear()
    typeListeners.clear()
    try {
      await unlink(logPath)
    } catch (err: unknown) {
      if (!isENOENT(err)) throw err
    }
  }

  return {
    append,
    read,
    lastSeq: () => seq,
    subscribe,
    subscribeType,
    close,
    _resetForTest,
  }
}

// ==================== Helpers ====================

/** Read the last line of the log file to recover the seq counter. */
async function recoverLastSeq(logPath: string): Promise<number> {
  let raw: string
  try {
    raw = await readFile(logPath, 'utf-8')
  } catch (err: unknown) {
    if (isENOENT(err)) return 0
    throw err
  }

  if (!raw.trim()) return 0

  // Walk backwards to find the last non-empty line
  const lines = raw.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const entry: EventLogEntry = JSON.parse(line)
      return entry.seq
    } catch {
      // Skip malformed, keep scanning
    }
  }

  return 0
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
