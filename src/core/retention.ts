/**
 * Data retention — purge old JSONL files and entries based on configurable age limits.
 *
 * Reads retention policy from data/config/retention.json.
 * Each category specifies maxDays — entries older than that are removed.
 *
 * For JSONL files: rewrites the file keeping only recent entries.
 * For monthly files (YYYY-MM.jsonl): deletes entire files older than retention.
 */

import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { resolve, basename } from 'node:path'

interface RetentionPolicy {
  eventLog: { maxDays: number }
  signalLog: { maxDays: number }
  tradeReviews: { maxDays: number }
  newsItems: { maxDays: number }
}

const CONFIG_PATH = resolve('data/config/retention.json')

const DEFAULT_POLICY: RetentionPolicy = {
  eventLog: { maxDays: 30 },
  signalLog: { maxDays: 90 },
  tradeReviews: { maxDays: 365 },
  newsItems: { maxDays: 7 },
}

async function loadPolicy(): Promise<RetentionPolicy> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8')
    return { ...DEFAULT_POLICY, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_POLICY
  }
}

/**
 * Purge old entries from a JSONL file.
 * Keeps entries where the `ts` field (epoch ms) is within maxDays.
 * Returns the number of entries removed.
 */
async function purgeJsonl(filePath: string, maxDays: number): Promise<number> {
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000

  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return 0
  }

  const lines = raw.split('\n')
  const kept: string[] = []
  let removed = 0

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry.ts === 'number' && entry.ts < cutoff) {
        removed++
      } else {
        kept.push(line)
      }
    } catch {
      kept.push(line) // keep unparseable lines
    }
  }

  if (removed > 0) {
    await writeFile(filePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''))
  }

  return removed
}

/**
 * Purge old monthly JSONL files (YYYY-MM.jsonl) from a directory.
 * Deletes entire files where all entries would be older than maxDays.
 */
async function purgeMonthlyFiles(dirPath: string, maxDays: number): Promise<number> {
  const cutoffDate = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000)
  const cutoffYM = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}`

  let files: string[]
  try {
    files = await readdir(dirPath)
  } catch {
    return 0
  }

  let removed = 0
  for (const file of files) {
    const match = /^(\d{4}-\d{2})\.jsonl$/.exec(file)
    if (!match) continue
    if (match[1] < cutoffYM) {
      try {
        await unlink(resolve(dirPath, file))
        removed++
      } catch { /* skip */ }
    }
  }

  return removed
}

/**
 * Run the full retention cleanup. Call this from a daily cron or on startup.
 */
export async function runRetentionCleanup(): Promise<{
  eventLog: number
  signalLog: number
  tradeReviews: number
  newsItems: number
}> {
  const policy = await loadPolicy()

  const eventLog = await purgeJsonl(
    resolve('data/event-log/events.jsonl'),
    policy.eventLog.maxDays,
  )

  const signalLog = await purgeJsonl(
    resolve('data/signal-log/signals.jsonl'),
    policy.signalLog.maxDays,
  )

  const tradeReviews = await purgeMonthlyFiles(
    resolve('data/trade-reviews'),
    policy.tradeReviews.maxDays,
  )

  const newsItems = await purgeJsonl(
    resolve('data/news-archive/articles.jsonl'),
    policy.newsItems.maxDays,
  )

  const total = eventLog + signalLog + tradeReviews + newsItems
  if (total > 0) {
    console.log(`retention: purged ${total} items (events=${eventLog}, signals=${signalLog}, reviews=${tradeReviews}, news=${newsItems})`)
  }

  return { eventLog, signalLog, tradeReviews, newsItems }
}
