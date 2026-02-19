import type { Update } from './types.js'
import type { TelegramClient } from './client.js'

export interface PollingOptions {
  client: TelegramClient
  timeout: number
  onUpdates: (updates: Update[]) => void
  onError?: (error: unknown) => void
  signal: AbortSignal
}

const MAX_BACKOFF_MS = 30_000

/**
 * Long-polls Telegram getUpdates in a loop until signal is aborted.
 * Exponential backoff on error (1s → 2s → 4s → ... → 30s), reset on success.
 */
export async function runPollingLoop(options: PollingOptions): Promise<void> {
  const { client, timeout, onUpdates, onError, signal } = options
  let offset: number | undefined
  let backoffMs = 0

  while (!signal.aborted) {
    try {
      const updates = await client.getUpdates(offset, timeout, signal)

      // Reset backoff on success
      backoffMs = 0

      if (updates.length > 0) {
        offset = Math.max(...updates.map((u) => u.update_id)) + 1
        onUpdates(updates)
      }
    } catch (err: unknown) {
      if (signal.aborted) break

      onError?.(err)

      // Exponential backoff
      backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      await sleep(backoffMs, signal)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
