/**
 * Structured trade memory — learns from trade outcomes.
 *
 * Stores patterns indexed by strategy+symbol+regime with win rates,
 * AI-written lessons, and recent insights. Used by AI Judge to
 * evaluate signals with historical context.
 *
 * File: data/brain/trade-memory.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createLogger } from '../../core/logger.js'

const log = createLogger('trade-memory')
const MEMORY_FILE = resolve('data/brain/trade-memory.json')
const MAX_PATTERNS = 100
const MAX_RECENT_LESSONS = 10

// ==================== Types ====================

export interface TradePattern {
  /** Composite key: "{strategy}|{symbol}|{regime}" */
  id: string
  strategy: string
  symbol: string
  regime: string
  samples: number
  wins: number
  losses: number
  winRate: number
  avgPnl: number
  /** AI-written 1-2 sentence lesson (overwritten each update) */
  lesson: string
  lastUpdated: string
}

export interface TradeMemoryState {
  patterns: TradePattern[]
  /** Last N AI-written lessons (FIFO, newest first) */
  recentLessons: string[]
}

// ==================== Core Functions ====================

export async function loadTradeMemory(): Promise<TradeMemoryState> {
  try {
    const raw = await readFile(MEMORY_FILE, 'utf-8')
    return JSON.parse(raw) as TradeMemoryState
  } catch {
    return { patterns: [], recentLessons: [] }
  }
}

async function saveTradeMemory(memory: TradeMemoryState): Promise<void> {
  await mkdir(dirname(MEMORY_FILE), { recursive: true })
  await writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2))
}

/**
 * Update or create a trade pattern.
 * Increments win/loss counts and updates lesson text.
 */
export async function updatePattern(params: {
  strategy: string
  symbol: string
  regime: string
  outcome: 'win' | 'loss'
  pnlPercent: number
  lesson: string
}): Promise<TradePattern> {
  const memory = await loadTradeMemory()
  const id = `${params.strategy}|${params.symbol}|${params.regime}`

  let pattern = memory.patterns.find(p => p.id === id)
  if (!pattern) {
    pattern = {
      id,
      strategy: params.strategy,
      symbol: params.symbol,
      regime: params.regime,
      samples: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgPnl: 0,
      lesson: '',
      lastUpdated: new Date().toISOString(),
    }
    memory.patterns.push(pattern)
  }

  // Update counts
  pattern.samples++
  if (params.outcome === 'win') pattern.wins++
  else pattern.losses++

  const total = pattern.wins + pattern.losses
  pattern.winRate = total > 0 ? Math.round((pattern.wins / total) * 100) : 0

  // Rolling average PnL
  pattern.avgPnl = Math.round(
    ((pattern.avgPnl * (pattern.samples - 1) + params.pnlPercent) / pattern.samples) * 100
  ) / 100

  pattern.lesson = params.lesson
  pattern.lastUpdated = new Date().toISOString()

  // Enforce max patterns (LRU eviction)
  if (memory.patterns.length > MAX_PATTERNS) {
    memory.patterns.sort((a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
    )
    memory.patterns = memory.patterns.slice(0, MAX_PATTERNS)
  }

  await saveTradeMemory(memory)
  log.info('pattern updated', { id, winRate: pattern.winRate, samples: pattern.samples })
  return pattern
}

/**
 * Add a lesson to the recent lessons list.
 */
export async function addLesson(lesson: string): Promise<void> {
  const memory = await loadTradeMemory()
  memory.recentLessons = [lesson, ...memory.recentLessons].slice(0, MAX_RECENT_LESSONS)
  await saveTradeMemory(memory)
}

/**
 * Query patterns relevant to a signal's context.
 * Matches by strategy, symbol, and/or regime (all optional filters).
 */
export async function getRelevantPatterns(
  strategy?: string,
  symbol?: string,
  regime?: string,
): Promise<{ patterns: TradePattern[]; recentLessons: string[] }> {
  const memory = await loadTradeMemory()

  let filtered = memory.patterns
  if (strategy) filtered = filtered.filter(p => p.strategy === strategy)
  if (symbol) filtered = filtered.filter(p => p.symbol === symbol)
  if (regime) filtered = filtered.filter(p => p.regime === regime)

  // Sort by relevance: most samples first
  filtered.sort((a, b) => b.samples - a.samples)

  return {
    patterns: filtered.slice(0, 20),
    recentLessons: memory.recentLessons,
  }
}
