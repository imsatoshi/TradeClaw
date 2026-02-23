/**
 * Funding rate history log — persists funding rate snapshots to disk.
 *
 * File: data/funding-rates/funding-rate-log.json
 * Format: array of FundingRateSnapshot, newest first, capped at MAX_ENTRIES.
 *
 * Auto-appended on each cryptoGetFundingRate call (fire-and-forget).
 * Query with readFundingRateHistory or computeFundingRateStats.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import type { FundingRateInfo } from '../../analysis-kit/tools/strategy-scanner/types.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('funding-rate-log')
const LOG_FILE = resolve('data/funding-rates/funding-rate-log.json')
const MAX_ENTRIES = 5000

export interface FundingRateSnapshot {
  timestamp: string           // ISO — collection time
  symbol: string              // "BTC/USDT"
  fundingRate: number         // raw decimal e.g. 0.0001
  fundingRatePercent: string  // "0.0100%"
  markPrice: number
}

// ==================== Persistence ====================

async function loadLog(): Promise<FundingRateSnapshot[]> {
  try {
    const raw = await readFile(LOG_FILE, 'utf-8')
    return JSON.parse(raw) as FundingRateSnapshot[]
  } catch {
    return []
  }
}

async function saveLog(entries: FundingRateSnapshot[]): Promise<void> {
  await mkdir(dirname(LOG_FILE), { recursive: true })
  await writeFile(LOG_FILE, JSON.stringify(entries, null, 2))
}

// ==================== Append ====================

/**
 * Batch-append current funding rate snapshots to the log.
 * Called fire-and-forget from cryptoGetFundingRate.
 */
export async function appendFundingRateLog(
  rates: Record<string, FundingRateInfo>,
): Promise<void> {
  const symbols = Object.keys(rates)
  if (symbols.length === 0) return

  try {
    const entries = await loadLog()
    const timestamp = new Date().toISOString()

    const newEntries: FundingRateSnapshot[] = symbols.map((sym) => ({
      timestamp,
      symbol: rates[sym].symbol,
      fundingRate: rates[sym].fundingRate,
      fundingRatePercent: rates[sym].fundingRatePercent,
      markPrice: rates[sym].markPrice,
    }))

    const updated = [...newEntries, ...entries].slice(0, MAX_ENTRIES)
    await saveLog(updated)
    log.info(`appended ${newEntries.length} funding rate snapshot(s)`, { total: updated.length })
  } catch (err) {
    log.warn('failed to append funding rate log', { error: err instanceof Error ? err.message : String(err) })
  }
}

// ==================== Read ====================

/**
 * Read historical funding rate snapshots.
 * Optionally filter by symbol and limit results.
 */
export async function readFundingRateHistory(opts: {
  symbol?: string
  limit?: number
} = {}): Promise<FundingRateSnapshot[]> {
  const entries = await loadLog()
  const { symbol, limit = 50 } = opts

  const filtered = symbol
    ? entries.filter((e) => e.symbol.toUpperCase() === symbol.toUpperCase())
    : entries

  return filtered.slice(0, limit)
}

// ==================== Stats ====================

/**
 * Compute funding rate statistics for a symbol.
 *
 * Returns:
 * - avg24h / avg7d: average funding rate over those periods
 * - extremeHighCount: snapshots where rate > 0.1% (0.001)
 * - extremeLowCount: snapshots where rate < -0.05% (-0.0005)
 * - cumulativeCarryCost24h / 7d: sum of rates (approximate carry)
 */
export async function computeFundingRateStats(symbol: string): Promise<{
  symbol: string
  totalSnapshots: number
  avg24h: string
  avg7d: string
  extremeHighCount: number
  extremeLowCount: number
  cumulativeCarryCost24h: string
  cumulativeCarryCost7d: string
  latestRate: string | null
}> {
  const entries = await loadLog()
  const all = entries.filter((e) => e.symbol.toUpperCase() === symbol.toUpperCase())

  if (all.length === 0) {
    return {
      symbol,
      totalSnapshots: 0,
      avg24h: 'N/A',
      avg7d: 'N/A',
      extremeHighCount: 0,
      extremeLowCount: 0,
      cumulativeCarryCost24h: 'N/A',
      cumulativeCarryCost7d: 'N/A',
      latestRate: null,
    }
  }

  const now = Date.now()
  const MS_24H = 24 * 60 * 60 * 1000
  const MS_7D = 7 * MS_24H

  const last24h = all.filter((e) => now - new Date(e.timestamp).getTime() < MS_24H)
  const last7d = all.filter((e) => now - new Date(e.timestamp).getTime() < MS_7D)

  const avg = (arr: FundingRateSnapshot[]) =>
    arr.length > 0
      ? `${((arr.reduce((s, e) => s + e.fundingRate, 0) / arr.length) * 100).toFixed(4)}%`
      : 'N/A'

  const cumulative = (arr: FundingRateSnapshot[]) =>
    arr.length > 0
      ? `${(arr.reduce((s, e) => s + e.fundingRate, 0) * 100).toFixed(4)}%`
      : 'N/A'

  const extremeHighCount = all.filter((e) => e.fundingRate > 0.001).length   // > 0.1%
  const extremeLowCount = all.filter((e) => e.fundingRate < -0.0005).length  // < -0.05%

  return {
    symbol,
    totalSnapshots: all.length,
    avg24h: avg(last24h),
    avg7d: avg(last7d),
    extremeHighCount,
    extremeLowCount,
    cumulativeCarryCost24h: cumulative(last24h),
    cumulativeCarryCost7d: cumulative(last7d),
    latestRate: all[0]?.fundingRatePercent ?? null,
  }
}
