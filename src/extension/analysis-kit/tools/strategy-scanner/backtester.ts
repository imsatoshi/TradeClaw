/**
 * Signal backtester & parameter optimizer — 5m unified architecture.
 *
 * - runBacktest:      replay strategy scanner on historical 5m data, simulate exits
 * - optimizeParams:   grid-search over SL/TP multipliers to find best expectancy
 *
 * All 6 strategies run on 5m candles. 1H data used for regime detection only.
 * Both share collectSignals() which fetches data and runs strategies once.
 * The optimizer then replays exits cheaply with different SL/TP multipliers.
 */

import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import type { StrategySignal, StrategyName, FundingRateInfo } from './types.js'
import type { MarketRegime } from './regime.js'
import { fetchHistoricalOHLCV } from '../../../archive-analysis/data/ExchangeClient.js'
import { fetchFundingRates } from '../../../archive-analysis/data/FundingRateClient.js'
import { scanRsiDivergence } from './strategies/rsi-divergence.js'
import { scanEmaTrend } from './strategies/ema-trend.js'
import { scanBreakoutVolume } from './strategies/breakout-volume.js'
import { scanFundingFade } from './strategies/funding-fade.js'
import { scanBBMeanRevert } from './strategies/bb-mean-revert.js'
import { scanStructureBreak } from './strategies/structure-break.js'
import { detectMarketRegime, applyRegimeFilter } from './regime.js'
import { getStrategyParams, getStrategyParamsFor } from './config.js'
import { createLogger } from '../../../../core/logger.js'
import { walkForwardOptimize } from './wfo.js'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

const log = createLogger('backtester')

// ==================== Backtest interfaces ====================

export interface BacktestConfig {
  symbol: string
  days: number                    // default 90
  strategies?: StrategyName[]     // default all 6
  confidenceMin?: number          // default 0
  maxHoldBars?: number            // default 144 (12h of 5m bars)
}

export interface BacktestTradeResult {
  strategy: StrategyName
  direction: 'long' | 'short'
  confidence: number
  regime: string
  entry: number
  stopLoss: number
  takeProfit: number
  exitPrice: number
  exitReason: 'tp_hit' | 'sl_hit' | 'timeout'
  pnlPercent: number
  holdBars: number
}

export interface BacktestSummary {
  total: number
  wins: number
  losses: number
  timeouts: number
  winRate: number
  avgPnlPercent: number
  avgWinPercent: number
  avgLossPercent: number
  expectancy: number
  sharpe: number                  // mean(pnl) / std(pnl), 0 if < 2 trades
  maxConsecutiveLosses: number
}

export interface BacktestResult {
  symbol: string
  period: { start: string; end: string }
  totalSignals: number
  results: BacktestTradeResult[]
  summary: BacktestSummary
  perStrategy: Record<string, BacktestSummary>
  perRegime: Record<string, BacktestSummary>
}

// ==================== Optimizer interfaces ====================

export interface OptimizeConfig {
  symbol: string
  days: number                        // default 90
  strategies?: StrategyName[]
  confidenceMin?: number
  maxHoldBars?: number
  slRange?: number[]                  // default [0.75, 1.0, 1.25, 1.5, 2.0]
  tpRange?: number[]                  // default [1.5, 2.0, 2.5, 3.0, 3.5]
  apply?: boolean                     // write best params to strategy-params.json
}

export interface ParamComboResult {
  slMultiplier: number
  tpMultiplier: number
  riskReward: number                  // tpMult / slMult
  total: number
  winRate: number
  avgPnlPercent: number
  expectancy: number
}

export interface OptimizeResult {
  symbol: string
  period: { start: string; end: string }
  totalSignals: number
  best: ParamComboResult
  top5: ParamComboResult[]
  perStrategy: Record<string, { best: ParamComboResult; current: ParamComboResult | null }>
  applied: boolean
  recommendation: string
}

// ==================== Internal: raw signal with ATR ====================

export interface RawSignalEntry {
  signal: StrategySignal
  atr: number                         // 5m ATR at signal time
  regime: string
  simStartIdx: number                 // index into bars5m for exit simulation
  signalTimeMs: number                // epoch ms — used by WFO to filter by date
}

export interface CollectedSignals {
  rawSignals: RawSignalEntry[]
  bars5m: MarketData[]
  scanStart: number                   // ms
  endTime: number                     // ms
}

// ==================== Summary helpers ====================

export function buildSummary(trades: BacktestTradeResult[]): BacktestSummary {
  const total = trades.length
  if (total === 0) {
    return {
      total: 0, wins: 0, losses: 0, timeouts: 0,
      winRate: 0, avgPnlPercent: 0, avgWinPercent: 0, avgLossPercent: 0,
      expectancy: 0, sharpe: 0, maxConsecutiveLosses: 0,
    }
  }

  const wins = trades.filter(t => t.pnlPercent > 0)
  const losses = trades.filter(t => t.pnlPercent < 0)
  const timeouts = trades.filter(t => t.exitReason === 'timeout')

  const winRate = (wins.length / total) * 100
  const avgPnl = trades.reduce((s, t) => s + t.pnlPercent, 0) / total
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length : 0

  const wr = winRate / 100
  const expectancy = wr * avgWin - (1 - wr) * Math.abs(avgLoss)

  // Sharpe: mean(pnl) / std(pnl), no annualization (used for relative comparison)
  let sharpe = 0
  if (total >= 2) {
    const variance = trades.reduce((s, t) => s + (t.pnlPercent - avgPnl) ** 2, 0) / (total - 1)
    const std = Math.sqrt(variance)
    sharpe = std > 0 ? avgPnl / std : 0
  }

  let maxConsec = 0
  let curConsec = 0
  for (const t of trades) {
    if (t.pnlPercent <= 0) {
      curConsec++
      if (curConsec > maxConsec) maxConsec = curConsec
    } else {
      curConsec = 0
    }
  }

  return {
    total,
    wins: wins.length,
    losses: losses.length,
    timeouts: timeouts.length,
    winRate: round(winRate, 2),
    avgPnlPercent: round(avgPnl, 4),
    avgWinPercent: round(avgWin, 4),
    avgLossPercent: round(avgLoss, 4),
    expectancy: round(expectancy, 4),
    sharpe: round(sharpe, 4),
    maxConsecutiveLosses: maxConsec,
  }
}

function round(v: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(v * f) / f
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {}
  for (const item of items) {
    const key = keyFn(item)
    ;(groups[key] ??= []).push(item)
  }
  return groups
}

// ==================== Exit simulation ====================

/**
 * Simulate exit using explicit SL/TP levels.
 *
 * - long:  low <= SL → sl_hit,  high >= TP → tp_hit
 * - short: high >= SL → sl_hit, low  <= TP → tp_hit
 * - Same bar SL+TP → conservative sl_hit
 * - maxHoldBars exceeded → timeout at bar close
 */
function simulateExit(
  direction: 'long' | 'short',
  stopLoss: number,
  takeProfit: number,
  bars5m: MarketData[],
  startIdx: number,
  maxHoldBars: number,
): { exitPrice: number; exitReason: 'tp_hit' | 'sl_hit' | 'timeout'; holdBars: number } {
  for (let i = startIdx; i < bars5m.length && (i - startIdx) < maxHoldBars; i++) {
    const bar = bars5m[i]

    if (direction === 'long') {
      const slHit = bar.low <= stopLoss
      const tpHit = bar.high >= takeProfit
      if (slHit && tpHit) return { exitPrice: stopLoss, exitReason: 'sl_hit', holdBars: i - startIdx + 1 }
      if (slHit) return { exitPrice: stopLoss, exitReason: 'sl_hit', holdBars: i - startIdx + 1 }
      if (tpHit) return { exitPrice: takeProfit, exitReason: 'tp_hit', holdBars: i - startIdx + 1 }
    } else {
      const slHit = bar.high >= stopLoss
      const tpHit = bar.low <= takeProfit
      if (slHit && tpHit) return { exitPrice: stopLoss, exitReason: 'sl_hit', holdBars: i - startIdx + 1 }
      if (slHit) return { exitPrice: stopLoss, exitReason: 'sl_hit', holdBars: i - startIdx + 1 }
      if (tpHit) return { exitPrice: takeProfit, exitReason: 'tp_hit', holdBars: i - startIdx + 1 }
    }
  }

  const lastIdx = Math.min(startIdx + maxHoldBars - 1, bars5m.length - 1)
  return { exitPrice: bars5m[lastIdx].close, exitReason: 'timeout', holdBars: lastIdx - startIdx + 1 }
}

// ==================== Evaluate a single (SL, TP) combo against signals ====================

/**
 * For a given (slMult, tpMult), replay all signals using the provided bars
 * and return summary stats. Standalone function used by both optimizeParams and WFO.
 */
export function evaluateCombo(
  slMult: number,
  tpMult: number,
  signals: RawSignalEntry[],
  bars5m: MarketData[],
  maxHoldBars: number,
): { combo: ParamComboResult; trades: BacktestTradeResult[] } {
  const trades: BacktestTradeResult[] = []

  for (const { signal, atr, regime, simStartIdx } of signals) {
    if (atr <= 0) continue

    const sl = signal.direction === 'long'
      ? signal.entry - slMult * atr
      : signal.entry + slMult * atr
    const tp = signal.direction === 'long'
      ? signal.entry + tpMult * atr
      : signal.entry - tpMult * atr

    const exit = simulateExit(signal.direction, sl, tp, bars5m, simStartIdx, maxHoldBars)

    const pnlPercent = signal.direction === 'long'
      ? ((exit.exitPrice - signal.entry) / signal.entry) * 100
      : ((signal.entry - exit.exitPrice) / signal.entry) * 100

    trades.push({
      strategy: signal.strategy,
      direction: signal.direction,
      confidence: signal.confidence,
      regime,
      entry: signal.entry,
      stopLoss: sl,
      takeProfit: tp,
      exitPrice: exit.exitPrice,
      exitReason: exit.exitReason,
      pnlPercent: round(pnlPercent, 4),
      holdBars: exit.holdBars,
    })
  }

  const summary = buildSummary(trades)
  return {
    combo: {
      slMultiplier: slMult,
      tpMultiplier: tpMult,
      riskReward: round(tpMult / slMult, 2),
      total: summary.total,
      winRate: summary.winRate,
      avgPnlPercent: summary.avgPnlPercent,
      expectancy: summary.expectancy,
    },
    trades,
  }
}

// ==================== Signal collection (shared by backtest + optimizer) ====================

export async function collectSignals(config: {
  symbol: string
  days: number
  strategies?: StrategyName[]
  confidenceMin?: number
}): Promise<CollectedSignals> {
  const { symbol, days, strategies, confidenceMin = 0 } = config
  const now = Date.now()
  const MS_PER_DAY = 86_400_000

  const endTime = now
  const start5m = now - (days + 2) * MS_PER_DAY   // extra 2 days for lookback
  const start1h = now - (days + 5) * MS_PER_DAY   // extra 5 days for regime EMA55
  const scanStart = now - days * MS_PER_DAY

  // Sequential fetches to avoid Binance rate limit bursts
  const bars5m = await fetchHistoricalOHLCV(symbol, '5m', start5m, endTime)
  const bars1h = await fetchHistoricalOHLCV(symbol, '1h', start1h, endTime)

  log.info('historical data fetched', { bars5m: bars5m.length, bars1h: bars1h.length })

  if (bars5m.length < 300) throw new Error(`Insufficient 5m data for ${symbol}: ${bars5m.length} bars (need 300+)`)

  let fundingRates: Record<string, FundingRateInfo> = {}
  const runFunding = !strategies || strategies.includes('funding_fade')
  if (runFunding) {
    fundingRates = await fetchFundingRates([symbol]).catch(() => ({}))
  }

  const enabledStrategies = new Set<StrategyName>(
    strategies ?? ['rsi_divergence', 'ema_trend', 'breakout_volume', 'funding_fade', 'bb_mean_revert', 'structure_break'],
  )

  // Binary search helper for 1H bar alignment (regime detection)
  const bars1hTimes = bars1h.map(b => b.time)
  function find1hIdx(timeSec: number): number {
    let lo = 0, hi = bars1hTimes.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (bars1hTimes[mid] < timeSec) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const rawSignals: RawSignalEntry[] = []

  // ── Single 5m loop: all 6 strategies ──
  const MIN_5M_LOOKBACK = 300
  // Deduplication: prevent same strategy+direction within 12 bars (1 hour on 5m)
  const DEDUP_COOLDOWN = 12
  const lastSignalBar = new Map<string, number>()

  for (let i = MIN_5M_LOOKBACK; i < bars5m.length; i++) {
    const scanBar = bars5m[i]
    const scanTimeSec = scanBar.time

    if (scanTimeSec * 1000 < scanStart) continue

    // Slice 5m window for strategies
    const window5m = bars5m.slice(Math.max(0, i - MIN_5M_LOOKBACK), i + 1)

    // Find aligned 1H window for regime detection
    const aligned1hIdx = find1hIdx(scanTimeSec + 1) - 1
    let regime: MarketRegime = {
      symbol, regime: 'ranging', emaFast: 0, emaMid: 0, emaSlow: 0,
      price: scanBar.close, priceVsEma55: 0, rsi: 50, reason: 'insufficient 1H data',
    }
    if (aligned1hIdx >= 55) {
      const window1h = bars1h.slice(Math.max(0, aligned1hIdx - 59), aligned1hIdx + 1)
      const regimes = detectMarketRegime([symbol], { [symbol]: window1h })
      if (regimes[0]) regime = regimes[0]
    }

    // Run all 6 strategies on 5m data
    const signals: StrategySignal[] = []
    if (enabledStrategies.has('rsi_divergence')) {
      try { signals.push(...await scanRsiDivergence(symbol, window5m)) } catch { /* skip */ }
    }
    if (enabledStrategies.has('ema_trend')) {
      try { signals.push(...await scanEmaTrend(symbol, window5m)) } catch { /* skip */ }
    }
    if (enabledStrategies.has('breakout_volume')) {
      try { signals.push(...await scanBreakoutVolume(symbol, window5m)) } catch { /* skip */ }
    }
    if (enabledStrategies.has('funding_fade')) {
      const funding = fundingRates[symbol]
      if (funding) {
        try { signals.push(...await scanFundingFade(symbol, window5m, funding)) } catch { /* skip */ }
      }
    }
    if (enabledStrategies.has('bb_mean_revert')) {
      try { signals.push(...await scanBBMeanRevert(symbol, window5m)) } catch { /* skip */ }
    }
    if (enabledStrategies.has('structure_break')) {
      try { signals.push(...await scanStructureBreak(symbol, window5m)) } catch { /* skip */ }
    }

    const confFiltered = signals.filter(s => s.confidence >= confidenceMin)
    const regimeFiltered = applyRegimeFilter(confFiltered, regime)

    const simStartIdx = i + 1 // next 5m bar after signal
    if (simStartIdx >= bars5m.length) continue

    for (const signal of regimeFiltered) {
      // Dedup: skip if same strategy+direction fired within cooldown
      const dedupKey = `${signal.strategy}:${signal.direction}`
      const lastBar = lastSignalBar.get(dedupKey)
      if (lastBar !== undefined && i - lastBar < DEDUP_COOLDOWN) continue
      lastSignalBar.set(dedupKey, i)

      const atr = typeof signal.details.atr === 'number' ? signal.details.atr : 0
      rawSignals.push({ signal, atr, regime: regime.regime, simStartIdx, signalTimeMs: scanTimeSec * 1000 })
    }
  }

  // Already in chronological order (single ascending loop)
  return { rawSignals, bars5m, scanStart, endTime }
}

// ==================== runBacktest ====================

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  const { symbol, days = 90, strategies, confidenceMin = 0, maxHoldBars = 144 } = config

  log.info('backtest started', { symbol, days, strategies, confidenceMin })

  const { rawSignals, bars5m, scanStart, endTime } = await collectSignals({
    symbol, days, strategies, confidenceMin,
  })

  const results: BacktestTradeResult[] = []

  for (const { signal, regime, simStartIdx } of rawSignals) {
    const exit = simulateExit(
      signal.direction, signal.stopLoss, signal.takeProfit,
      bars5m, simStartIdx, maxHoldBars,
    )

    const pnlPercent = signal.direction === 'long'
      ? ((exit.exitPrice - signal.entry) / signal.entry) * 100
      : ((signal.entry - exit.exitPrice) / signal.entry) * 100

    results.push({
      strategy: signal.strategy,
      direction: signal.direction,
      confidence: signal.confidence,
      regime,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      exitPrice: exit.exitPrice,
      exitReason: exit.exitReason,
      pnlPercent: round(pnlPercent, 4),
      holdBars: exit.holdBars,
    })
  }

  const summary = buildSummary(results)

  const perStrategy: Record<string, BacktestSummary> = {}
  for (const [key, trades] of Object.entries(groupBy(results, t => t.strategy))) {
    perStrategy[key] = buildSummary(trades)
  }

  const perRegime: Record<string, BacktestSummary> = {}
  for (const [key, trades] of Object.entries(groupBy(results, t => t.regime))) {
    perRegime[key] = buildSummary(trades)
  }

  log.info('backtest complete', {
    symbol, totalSignals: results.length,
    winRate: summary.winRate, expectancy: summary.expectancy,
  })

  return {
    symbol,
    period: { start: new Date(scanStart).toISOString(), end: new Date(endTime).toISOString() },
    totalSignals: results.length,
    results,
    summary,
    perStrategy,
    perRegime,
  }
}

// ==================== optimizeParams ====================

/**
 * Grid-search over SL/TP multiplier combinations to find optimal params.
 *
 * Runs strategy scanning ONCE, then replays exit simulation for each combo.
 * Very fast: ~50 combos × N signals is just arithmetic, no API calls.
 */
export async function optimizeParams(config: OptimizeConfig): Promise<OptimizeResult> {
  const {
    symbol,
    days = 90,
    strategies,
    confidenceMin = 0,
    maxHoldBars = 144,
    slRange = [0.75, 1.0, 1.25, 1.5, 2.0],
    tpRange = [1.5, 2.0, 2.5, 3.0, 3.5],
    apply = false,
  } = config

  log.info('optimize started', { symbol, days, slRange, tpRange, combos: slRange.length * tpRange.length })

  const { rawSignals, bars5m, scanStart, endTime } = await collectSignals({
    symbol, days, strategies, confidenceMin,
  })

  if (rawSignals.length === 0) {
    throw new Error(`No signals found for ${symbol} in ${days} days — cannot optimize`)
  }

  // Grid search — overall
  const allCombos: ParamComboResult[] = []
  for (const sl of slRange) {
    for (const tp of tpRange) {
      allCombos.push(evaluateCombo(sl, tp, rawSignals, bars5m, maxHoldBars).combo)
    }
  }
  allCombos.sort((a, b) => b.expectancy - a.expectancy)

  const best = allCombos[0]
  const top5 = allCombos.slice(0, 5)

  // Per-strategy optimization
  const stratGroups = groupBy(rawSignals, s => s.signal.strategy)
  const perStrategy: Record<string, { best: ParamComboResult; current: ParamComboResult | null }> = {}

  for (const [stratName, stratSignals] of Object.entries(stratGroups)) {
    const combos: ParamComboResult[] = []
    for (const sl of slRange) {
      for (const tp of tpRange) {
        combos.push(evaluateCombo(sl, tp, stratSignals, bars5m, maxHoldBars).combo)
      }
    }
    combos.sort((a, b) => b.expectancy - a.expectancy)

    // Evaluate current params for comparison (uses per-symbol merged config)
    const stratConfig = await getStrategyParamsFor(stratName, symbol)
    const curSl = stratConfig.slMultiplier ?? 1.5
    const curTp = stratConfig.tpMultiplier ?? 2.5
    const current = evaluateCombo(curSl, curTp, stratSignals, bars5m, maxHoldBars).combo

    perStrategy[stratName] = { best: combos[0], current }
  }

  // Auto-apply: write best per-strategy params into symbolOverrides[symbol]
  // This ensures optimized params only affect the target symbol, not global defaults.
  let applied = false
  if (apply) {
    try {
      const configPath = resolve('data/config/strategy-params.json')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let existing: Record<string, any> = {}
      try {
        existing = JSON.parse(await readFile(configPath, 'utf-8'))
      } catch { /* file missing, start fresh */ }

      // Ensure symbolOverrides structure exists
      if (!existing.symbolOverrides || typeof existing.symbolOverrides !== 'object') {
        existing.symbolOverrides = {}
      }
      if (!existing.symbolOverrides[symbol] || typeof existing.symbolOverrides[symbol] !== 'object') {
        existing.symbolOverrides[symbol] = {}
      }

      for (const [stratName, { best: stratBest }] of Object.entries(perStrategy)) {
        existing.symbolOverrides[symbol][stratName] = {
          ...(existing.symbolOverrides[symbol][stratName] ?? {}),
          slMultiplier: stratBest.slMultiplier,
          tpMultiplier: stratBest.tpMultiplier,
        }
      }

      await mkdir(dirname(configPath), { recursive: true })
      await writeFile(configPath, JSON.stringify(existing, null, 2))
      applied = true
      log.info('optimized params applied', { configPath })
    } catch (err) {
      log.warn('failed to apply optimized params', { error: String(err) })
    }
  }

  // Build human-readable recommendation
  const recLines: string[] = [`${symbol} ${days}d optimization (${rawSignals.length} signals):`]
  recLines.push(`Best overall: SL×${best.slMultiplier} TP×${best.tpMultiplier} (R:R ${best.riskReward}) → ${best.winRate}% win, expectancy ${best.expectancy}%`)
  for (const [stratName, { best: sb, current: sc }] of Object.entries(perStrategy)) {
    const curStr = sc
      ? `current SL×${sc.slMultiplier}/TP×${sc.tpMultiplier} → ${sc.expectancy}%`
      : 'no current params'
    const delta = sc ? round(sb.expectancy - sc.expectancy, 4) : 0
    recLines.push(`  ${stratName}: best SL×${sb.slMultiplier}/TP×${sb.tpMultiplier} → ${sb.expectancy}% (${delta >= 0 ? '+' : ''}${delta} vs ${curStr})`)
  }
  if (applied) recLines.push('✓ Params written to strategy-params.json')

  const recommendation = recLines.join('\n')

  log.info('optimize complete', {
    symbol,
    bestSl: best.slMultiplier,
    bestTp: best.tpMultiplier,
    bestExpectancy: best.expectancy,
    applied,
  })

  return {
    symbol,
    period: { start: new Date(scanStart).toISOString(), end: new Date(endTime).toISOString() },
    totalSignals: rawSignals.length,
    best,
    top5,
    perStrategy,
    applied,
    recommendation,
  }
}

// ==================== batchOptimize ====================

export interface BatchOptimizeConfig {
  symbols: string[]
  days: number              // default 90
  apply?: boolean           // write results to strategy-params.json
  concurrency?: number      // default 3
  useWfo?: boolean          // default true — use Walk-Forward Optimization
}

export interface SymbolOptResult {
  best: ParamComboResult
  totalSignals: number
  applied: boolean
  /** WFO Efficiency Ratio — only present when useWfo=true */
  wfoER?: number
  /** Monte Carlo p50 expectancy — only present when useWfo=true */
  mcP50?: number
  /** Whether WFO gates passed — only present when useWfo=true */
  gatesPassed?: boolean
  /** Which gates passed/failed */
  gates?: { wfoERPassed: boolean; mcP50Passed: boolean }
}

export interface BatchOptimizeResult {
  totalSymbols: number
  successCount: number
  errorCount: number
  skippedCount: number          // no signals found
  results: Record<string, SymbolOptResult>
  errors: Record<string, string>
  summary: string               // human-readable
}

/**
 * Run parameter optimization for multiple symbols with concurrency control.
 *
 * Processes symbols in parallel (default 3 concurrent) to stay within
 * Binance rate limits while keeping total time reasonable.
 *
 * ~80 symbols × 3 concurrent ≈ 2-3 minutes.
 */
export async function batchOptimize(config: BatchOptimizeConfig): Promise<BatchOptimizeResult> {
  const { symbols, days = 90, apply = false, concurrency = 1, useWfo = true } = config
  const t0 = Date.now()

  log.info('batch optimize started', { symbols: symbols.length, days, concurrency, useWfo })

  const results: Record<string, SymbolOptResult> = {}
  const errors: Record<string, string> = {}
  let skippedCount = 0
  let gatesFailedCount = 0

  // Process in chunks of `concurrency` with inter-batch delay to avoid Binance 418
  for (let i = 0; i < symbols.length; i += concurrency) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000)) // 1s between batches
    const batch = symbols.slice(i, i + concurrency)
    const promises = batch.map(async (symbol) => {
      try {
        if (useWfo) {
          // Walk-Forward Optimization with anti-overfitting gates
          const wfoResult = await walkForwardOptimize({
            symbol, totalDays: Math.max(days, 180), apply,
          })
          if (wfoResult.totalSignals === 0) { skippedCount++; return }

          const best = wfoResult.recommendedParams
          if (!best) {
            // Gates failed — params not applied
            gatesFailedCount++
            results[symbol] = {
              best: wfoResult.folds[0]?.isParams ?? { slMultiplier: 1, tpMultiplier: 2, riskReward: 2, total: 0, winRate: 0, avgPnlPercent: 0, expectancy: 0 },
              totalSignals: wfoResult.totalSignals,
              applied: false,
              wfoER: wfoResult.wfoEfficiencyRatio,
              mcP50: wfoResult.monteCarlo.p50Expectancy,
              gatesPassed: false,
              gates: { wfoERPassed: wfoResult.gates.wfoERPassed, mcP50Passed: wfoResult.gates.monteCarloP50Passed },
            }
            return
          }
          results[symbol] = {
            best,
            totalSignals: wfoResult.totalSignals,
            applied: wfoResult.applied,
            wfoER: wfoResult.wfoEfficiencyRatio,
            mcP50: wfoResult.monteCarlo.p50Expectancy,
            gatesPassed: true,
            gates: { wfoERPassed: true, mcP50Passed: true },
          }
        } else {
          // Legacy: plain grid search (no anti-overfitting)
          const result = await optimizeParams({ symbol, days, apply })
          if (result.totalSignals === 0) { skippedCount++; return }
          results[symbol] = {
            best: result.best,
            totalSignals: result.totalSignals,
            applied: result.applied,
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('No signals') || msg.includes('Insufficient') || msg.includes('0 valid folds')) {
          skippedCount++
        } else {
          errors[symbol] = msg
        }
      }
    })
    await Promise.all(promises)

    log.info('batch progress', {
      done: Math.min(i + concurrency, symbols.length),
      total: symbols.length,
      success: Object.keys(results).length,
      errors: Object.keys(errors).length,
    })
  }

  // Build summary
  const successCount = Object.keys(results).filter(s => results[s].gatesPassed !== false).length
  const errorCount = Object.keys(errors).length

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1)

  const lines: string[] = [
    `Batch optimization${useWfo ? ' (WFO)' : ''}: ${symbols.length} symbols, ${days}d (${elapsedSec}s)`,
    `Results: ${successCount} optimized, ${gatesFailedCount} gates-failed, ${skippedCount} skipped, ${errorCount} errors`,
    '',
  ]

  // Sort by expectancy descending, show top performers
  const sorted = Object.entries(results)
    .filter(([, r]) => r.gatesPassed !== false)
    .sort((a, b) => b[1].best.expectancy - a[1].best.expectancy)

  const positive = sorted.filter(([, r]) => r.best.expectancy > 0)
  const negative = sorted.filter(([, r]) => r.best.expectancy <= 0)

  if (positive.length > 0) {
    lines.push(`✅ Positive expectancy (${positive.length} symbols):`)
    for (const [sym, r] of positive.slice(0, 15)) {
      const erStr = r.wfoER != null ? ` ER=${r.wfoER}` : ''
      lines.push(`  ${sym}: SL×${r.best.slMultiplier} TP×${r.best.tpMultiplier} → exp ${r.best.expectancy}%, win ${r.best.winRate}%${erStr} (${r.totalSignals} signals)`)
    }
    if (positive.length > 15) lines.push(`  ... and ${positive.length - 15} more`)
  }

  if (negative.length > 0) {
    lines.push(`❌ Negative expectancy (${negative.length} symbols — avoid trading):`)
    for (const [sym, r] of negative.slice(0, 10)) {
      lines.push(`  ${sym}: best exp ${r.best.expectancy}%`)
    }
    if (negative.length > 10) lines.push(`  ... and ${negative.length - 10} more`)
  }

  if (gatesFailedCount > 0) {
    const failed = Object.entries(results).filter(([, r]) => r.gatesPassed === false)
    lines.push(`\n⚠️ Gates failed (${gatesFailedCount} symbols — params NOT applied):`)
    for (const [sym, r] of failed.slice(0, 10)) {
      const reasons: string[] = []
      if (r.gates && !r.gates.wfoERPassed) reasons.push(`ER=${r.wfoER ?? '?'} < 0.5 (overfitting)`)
      if (r.gates && !r.gates.mcP50Passed) reasons.push(`MC p50=${r.mcP50 ?? '?'}% ≤ 0 (no edge)`)
      if (reasons.length === 0) reasons.push('unknown')
      lines.push(`  ${sym}: ${reasons.join(', ')} [${r.totalSignals} signals]`)
    }
  }

  if (apply && successCount > 0) lines.push('\n✓ Optimized params written to strategy-params.json (per-symbol overrides)')

  const summary = lines.join('\n')
  log.info('batch optimize complete', { successCount, errorCount, skippedCount, gatesFailedCount })

  return { totalSymbols: symbols.length, successCount, errorCount, skippedCount, results, errors, summary }
}
