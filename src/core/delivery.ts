/**
 * Delivery Queue — file-driven outbound message persistence and retry.
 *
 * Design lineage: OpenClaw delivery-queue.ts, adapted to Little Pony's
 * file-driven philosophy.
 *
 * Flow:
 *   1. enqueue() — persist delivery to disk (atomic write)
 *   2. attempt delivery via the provided deliver function
 *   3. On success: ack() — remove file
 *   4. On failure: fail() — bump retryCount, compute backoff
 *   5. On max retries: move to failed/ subdirectory
 *
 * Recovery on startup: scan queue dir, retry any pending entries with
 * exponential backoff.
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir, unlink, stat, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

// ==================== Types ====================

export interface DeliveryEntry {
  id: string
  enqueuedAt: number
  /** Target channel (e.g. "telegram", "webhook", "slack"). */
  channel: string
  /** Recipient identifier (chat id, webhook url, etc.). */
  to: string
  /** Message content. */
  text: string
  /** Optional metadata for the delivery target. */
  meta?: Record<string, unknown>
  retryCount: number
  lastError?: string
}

export type DeliverFn = (entry: DeliveryEntry) => Promise<void>

export interface DeliveryQueueConfig {
  /** Root directory for the queue. Default: "data/delivery-queue". */
  queueDir: string
  /** Maximum retry attempts before moving to failed/. Default: 5. */
  maxRetries: number
}

// ==================== Backoff ====================

const BACKOFF_MS = [
  5_000,      // retry 1: 5s
  25_000,     // retry 2: 25s
  120_000,    // retry 3: 2m
  600_000,    // retry 4: 10m
] as const

export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) return 0
  const idx = Math.min(retryCount - 1, BACKOFF_MS.length - 1)
  return BACKOFF_MS[idx]
}

// ==================== File Operations ====================

function queueDir(config: DeliveryQueueConfig): string {
  return config.queueDir
}

function failedDir(config: DeliveryQueueConfig): string {
  return join(config.queueDir, 'failed')
}

function entryPath(config: DeliveryQueueConfig, id: string): string {
  return join(queueDir(config), `${id}.json`)
}

async function ensureDirs(config: DeliveryQueueConfig): Promise<void> {
  await mkdir(queueDir(config), { recursive: true })
  await mkdir(failedDir(config), { recursive: true })
}

/** Atomic write: write to tmp, then rename. */
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data, 'utf-8')
  await rename(tmp, path)
}

// ==================== Queue Operations ====================

/** Persist a delivery entry to disk. Returns the entry id. */
export async function enqueue(
  config: DeliveryQueueConfig,
  params: Omit<DeliveryEntry, 'id' | 'enqueuedAt' | 'retryCount'>,
): Promise<string> {
  await ensureDirs(config)

  const id = randomUUID()
  const entry: DeliveryEntry = {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    text: params.text,
    meta: params.meta,
    retryCount: 0,
  }

  await atomicWrite(entryPath(config, id), JSON.stringify(entry, null, 2))
  return id
}

/** Remove a successfully delivered entry. */
export async function ack(config: DeliveryQueueConfig, id: string): Promise<void> {
  try {
    await unlink(entryPath(config, id))
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return // already removed
    }
    throw err
  }
}

/** Update entry after a failed delivery attempt. */
export async function fail(config: DeliveryQueueConfig, id: string, error: string): Promise<void> {
  const path = entryPath(config, id)
  const raw = await readFile(path, 'utf-8')
  const entry: DeliveryEntry = JSON.parse(raw)
  entry.retryCount += 1
  entry.lastError = error
  await atomicWrite(path, JSON.stringify(entry, null, 2))
}

/** Move an entry to the failed/ subdirectory. */
export async function moveToFailed(config: DeliveryQueueConfig, id: string): Promise<void> {
  await mkdir(failedDir(config), { recursive: true })
  const src = entryPath(config, id)
  const dest = join(failedDir(config), `${id}.json`)
  await rename(src, dest)
}

/** Load all pending delivery entries from the queue directory. */
export async function loadPending(config: DeliveryQueueConfig): Promise<DeliveryEntry[]> {
  const dir = queueDir(config)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }

  const entries: DeliveryEntry[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const filePath = join(dir, file)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) continue
      const raw = await readFile(filePath, 'utf-8')
      entries.push(JSON.parse(raw))
    } catch {
      // Skip malformed or inaccessible entries
    }
  }

  return entries
}

// ==================== Recovery ====================

export interface RecoveryResult {
  recovered: number
  failed: number
  skipped: number
}

export interface RecoveryOpts {
  config: DeliveryQueueConfig
  deliver: DeliverFn
  /** Override for testing — resolves instead of real setTimeout. */
  delay?: (ms: number) => Promise<void>
  /** Maximum wall-clock time for recovery in ms. Default: 60_000. */
  maxRecoveryMs?: number
  log?: {
    info(msg: string): void
    warn(msg: string): void
  }
}

/**
 * On startup, scan the delivery queue and retry pending entries.
 * Respects exponential backoff and max retries.
 */
export async function recoverPending(opts: RecoveryOpts): Promise<RecoveryResult> {
  const { config, deliver, log } = opts
  const delayFn = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000)

  const pending = await loadPending(config)
  if (pending.length === 0) return { recovered: 0, failed: 0, skipped: 0 }

  // Process oldest first
  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  log?.info(`delivery recovery: ${pending.length} pending entries`)

  let recovered = 0
  let failed = 0
  let skipped = 0

  for (const entry of pending) {
    if (Date.now() >= deadline) {
      log?.warn(`delivery recovery: time budget exceeded, ${pending.length - recovered - failed - skipped} deferred`)
      break
    }

    if (entry.retryCount >= config.maxRetries) {
      log?.warn(`delivery ${entry.id}: max retries exceeded, moving to failed/`)
      try { await moveToFailed(config, entry.id) } catch { /* best effort */ }
      skipped += 1
      continue
    }

    const backoff = computeBackoffMs(entry.retryCount + 1)
    if (backoff > 0) {
      if (Date.now() + backoff >= deadline) {
        log?.warn(`delivery recovery: backoff exceeds time budget, deferring remaining`)
        break
      }
      await delayFn(backoff)
    }

    try {
      await deliver(entry)
      await ack(config, entry.id)
      recovered += 1
    } catch (err) {
      try { await fail(config, entry.id, err instanceof Error ? err.message : String(err)) } catch { /* best effort */ }
      failed += 1
    }
  }

  log?.info(`delivery recovery: ${recovered} recovered, ${failed} failed, ${skipped} skipped`)
  return { recovered, failed, skipped }
}
