/**
 * Signal history log — persists strategy signals to disk for performance tracking.
 *
 * File: data/signals/signal-log.json
 * Format: array of SignalLogEntry, newest first, capped at MAX_ENTRIES.
 *
 * Outcome tracking is done separately: when a position closes, the caller can
 * call markSignalOutcome(id, outcome, exitPrice) to record the result.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import type { StrategySignal } from './types.js'
import { createLogger } from '../../../../core/logger.js'

const log = createLogger('signal-log')
const LOG_FILE = resolve('data/signals/signal-log.json')
const MAX_ENTRIES = 1000

export interface SignalLogEntry {
  /** Unique ID: "{timestamp_ms}-{strategy}-{symbol}" */
  id: string
  /** ISO timestamp when signal was detected */
  timestamp: string
  /** The raw strategy signal */
  signal: StrategySignal
  /** Outcome — set later when position closes */
  outcome?: 'win' | 'loss' | 'skipped' | 'expired'
  /** Exit price when outcome is known */
  exitPrice?: number
  /** PnL percentage (positive = win) */
  pnlPercent?: number
}

async function loadLog(): Promise<SignalLogEntry[]> {
  try {
    const raw = await readFile(LOG_FILE, 'utf-8')
    return JSON.parse(raw) as SignalLogEntry[]
  } catch {
    return []
  }
}

async function saveLog(entries: SignalLogEntry[]): Promise<void> {
  await mkdir(dirname(LOG_FILE), { recursive: true })
  await writeFile(LOG_FILE, JSON.stringify(entries, null, 2))
}

/**
 * Append new signals to the log.
 * Called by runStrategyScan after each scan.
 */
export async function appendSignalLog(signals: StrategySignal[]): Promise<void> {
  if (signals.length === 0) return

  try {
    const entries = await loadLog()
    const timestamp = new Date().toISOString()

    const newEntries: SignalLogEntry[] = signals.map((signal) => ({
      id: `${Date.now()}-${signal.strategy}-${signal.symbol.replace('/', '')}`,
      timestamp,
      signal,
    }))

    const updated = [...newEntries, ...entries].slice(0, MAX_ENTRIES)
    await saveLog(updated)
    log.info(`appended ${signals.length} signal(s)`, { total: updated.length })
  } catch (err) {
    log.warn('failed to append signal log', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Read the most recent signal log entries.
 */
export async function readSignalLog(limit = 50): Promise<SignalLogEntry[]> {
  const entries = await loadLog()
  return entries.slice(0, limit)
}

/**
 * Mark the outcome of a previously logged signal.
 * Useful when a position closes to retroactively record win/loss.
 */
export async function markSignalOutcome(
  id: string,
  outcome: SignalLogEntry['outcome'],
  exitPrice?: number,
): Promise<boolean> {
  try {
    const entries = await loadLog()
    const idx = entries.findIndex((e) => e.id === id)
    if (idx === -1) return false

    const entry = entries[idx]
    entry.outcome = outcome
    entry.exitPrice = exitPrice

    if (exitPrice && entry.signal.entry) {
      const direction = entry.signal.direction
      const pnl = direction === 'long'
        ? (exitPrice - entry.signal.entry) / entry.signal.entry * 100
        : (entry.signal.entry - exitPrice) / entry.signal.entry * 100
      entry.pnlPercent = Math.round(pnl * 100) / 100
    }

    await saveLog(entries)
    return true
  } catch (err) {
    log.warn('failed to mark signal outcome', { id, error: String(err) })
    return false
  }
}

// ==================== Outcome Sync ====================

export interface ClosedTradeInput {
  symbol: string          // "ICP/USDT"
  direction: 'long' | 'short'
  openDate: string        // ISO
  closeDate: string       // ISO
  closeRate: number
  profitRatio: number     // positive = profit, negative = loss
}

/** Normalize symbol for comparison: strip ":USDT", convert to uppercase, remove spaces. */
function normalizeSymbol(s: string): string {
  return s.replace(/:USDT$/i, '').replace(/\s/g, '').toUpperCase()
}

/**
 * Match closed Freqtrade trades against unresolved signal log entries.
 * Matching criteria: same symbol + same direction + signal within 4h of trade open time.
 */
export async function syncOutcomesFromTrades(
  closedTrades: ClosedTradeInput[],
): Promise<{ matched: number; alreadyResolved: number }> {
  const entries = await loadLog()
  let matched = 0
  let alreadyResolved = 0

  for (const entry of entries) {
    if (entry.outcome) { alreadyResolved++; continue }

    const trade = closedTrades.find(t =>
      normalizeSymbol(t.symbol) === normalizeSymbol(entry.signal.symbol) &&
      t.direction === entry.signal.direction &&
      Math.abs(new Date(entry.timestamp).getTime() - new Date(t.openDate).getTime()) < 4 * 3600_000
    )
    if (!trade) continue

    const outcome = trade.profitRatio >= 0 ? 'win' : 'loss'
    await markSignalOutcome(entry.id, outcome, trade.closeRate)
    matched++
  }

  return { matched, alreadyResolved }
}

/**
 * Compute win-rate statistics per strategy from the log.
 */
export async function computeSignalStats(): Promise<Record<string, {
  total: number
  wins: number
  losses: number
  winRate: string
  avgPnl: string
}>> {
  const entries = await loadLog()
  const stats: Record<string, { total: number; wins: number; losses: number; pnls: number[] }> = {}

  for (const entry of entries) {
    const key = entry.signal.strategy
    if (!stats[key]) stats[key] = { total: 0, wins: 0, losses: 0, pnls: [] }

    stats[key].total++
    if (entry.outcome === 'win') { stats[key].wins++; if (entry.pnlPercent) stats[key].pnls.push(entry.pnlPercent) }
    if (entry.outcome === 'loss') { stats[key].losses++; if (entry.pnlPercent) stats[key].pnls.push(entry.pnlPercent) }
  }

  return Object.fromEntries(
    Object.entries(stats).map(([k, v]) => [k, {
      total: v.total,
      wins: v.wins,
      losses: v.losses,
      winRate: v.wins + v.losses > 0 ? `${Math.round(v.wins / (v.wins + v.losses) * 100)}%` : 'N/A',
      avgPnl: v.pnls.length > 0 ? `${(v.pnls.reduce((a, b) => a + b, 0) / v.pnls.length).toFixed(2)}%` : 'N/A',
    }])
  )
}
