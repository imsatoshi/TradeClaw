/**
 * Walk-Forward Optimization (WFO) — anti-overfitting framework.
 *
 * Instead of optimizing on the same data used for evaluation, WFO splits
 * historical data into rolling in-sample (IS) and out-of-sample (OOS) windows:
 *
 *   |── IS₁ ──|── OOS₁ ──|
 *              |── IS₂ ──|── OOS₂ ──|
 *                         |── IS₃ ──|── OOS₃ ──|
 *
 * For each fold:
 *   1. Optimize parameters on IS data (grid search)
 *   2. Evaluate those parameters on OOS data (no optimization)
 *
 * The OOS results are concatenated to form a realistic performance estimate.
 *
 * Gates:
 *   - WFO Efficiency Ratio = mean(OOS_Sharpe) / mean(IS_Sharpe)  ≥  0.5
 *   - Monte Carlo p50 expectancy > 0
 *
 * If either gate fails, parameters are NOT applied.
 *
 * References:
 *   - Bailey & Lopez de Prado (2014) — The Probability of Backtest Overfitting
 *   - Lopez de Prado (2018) — Advances in Financial Machine Learning, Ch. 7–12
 */

import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import type { StrategyName } from './types.js'
import type {
  ParamComboResult,
  BacktestTradeResult,
  RawSignalEntry,
  CollectedSignals,
} from './backtester.js'
import { collectSignals, evaluateCombo, buildSummary } from './backtester.js'
import { validateByMonteCarlo } from './monte-carlo.js'
import type { MonteCarloResult } from './monte-carlo.js'
import { getStrategyParamsFor } from './config.js'
import { createLogger } from '../../../../core/logger.js'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

const log = createLogger('wfo')

// ==================== WFO interfaces ====================

export interface WFOConfig {
  symbol: string
  totalDays?: number              // default 180
  isDays?: number                 // default 60 (in-sample window)
  oosDays?: number                // default 20 (out-of-sample window)
  strategies?: StrategyName[]
  confidenceMin?: number
  maxHoldBars?: number            // default 144 (12h of 5m bars)
  slRange?: number[]              // default [0.75, 1.0, 1.25, 1.5, 2.0]
  tpRange?: number[]              // default [1.5, 2.0, 2.5, 3.0, 3.5]
  monteCarloIterations?: number   // default 1000
  apply?: boolean                 // write to strategy-params.json if gates pass
}

export interface WFOFoldResult {
  fold: number
  /** Best params found during IS optimization */
  isParams: ParamComboResult
  /** IS Sharpe for that best combo */
  isSharpe: number
  /** OOS evaluation using IS-optimized params */
  oosResult: ParamComboResult
  /** OOS Sharpe */
  oosSharpe: number
  /** Number of IS signals */
  isSignalCount: number
  /** Number of OOS signals */
  oosSignalCount: number
}

export interface WFOResult {
  symbol: string
  period: { start: string; end: string }
  totalSignals: number
  folds: WFOFoldResult[]
  /** mean(OOS_Sharpe) / mean(IS_Sharpe) — should be > 0.5 */
  wfoEfficiencyRatio: number
  /** Monte Carlo validation on concatenated OOS trades */
  monteCarlo: MonteCarloResult
  /** Recommended params (from latest fold) — null if gates failed */
  recommendedParams: ParamComboResult | null
  /** Per-strategy recommended params — null if gates failed */
  perStrategy: Record<string, ParamComboResult> | null
  /** Whether params were written to config */
  applied: boolean
  /** Human-readable summary */
  recommendation: string
  /** Gate results */
  gates: {
    wfoERPassed: boolean
    monteCarloP50Passed: boolean
    allPassed: boolean
  }
}

// ==================== Core WFO ====================

/**
 * Run Walk-Forward Optimization for a single symbol.
 *
 * Fetches historical data for `totalDays`, generates all signals once,
 * then rolls through IS/OOS folds to produce unbiased OOS results.
 */
export async function walkForwardOptimize(config: WFOConfig): Promise<WFOResult> {
  const {
    symbol,
    totalDays = 180,
    isDays = 60,
    oosDays = 20,
    strategies,
    confidenceMin = 0,
    maxHoldBars = 144,
    slRange = [0.75, 1.0, 1.25, 1.5, 2.0],
    tpRange = [1.5, 2.0, 2.5, 3.0, 3.5],
    monteCarloIterations = 1000,
    apply = false,
  } = config

  const combos = slRange.length * tpRange.length
  const expectedFolds = Math.floor((totalDays - isDays) / oosDays)

  log.info('WFO started', {
    symbol, totalDays, isDays, oosDays,
    combos, expectedFolds,
  })

  // 1. Fetch all data and signals for the full period
  const collected = await collectSignals({
    symbol,
    days: totalDays,
    strategies,
    confidenceMin,
  })

  const { rawSignals, bars5m, scanStart, endTime } = collected

  if (rawSignals.length < 10) {
    throw new Error(`Insufficient signals for WFO on ${symbol}: ${rawSignals.length} (need 10+)`)
  }

  // 2. Build time-based index for bars5m (for clipping)
  const bars5mTimesMs = bars5m.map(b => b.time * 1000)

  function findBarIdx(timeMs: number): number {
    let lo = 0, hi = bars5mTimesMs.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (bars5mTimesMs[mid] < timeMs) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // 3. Generate fold boundaries (working backwards from endTime)
  const MS_PER_DAY = 86_400_000
  const folds: WFOFoldResult[] = []
  const allOosTrades: BacktestTradeResult[] = []

  for (let foldIdx = 0; foldIdx < expectedFolds; foldIdx++) {
    const oosEndMs = endTime - foldIdx * oosDays * MS_PER_DAY
    const oosStartMs = oosEndMs - oosDays * MS_PER_DAY
    const isEndMs = oosStartMs
    const isStartMs = isEndMs - isDays * MS_PER_DAY

    if (isStartMs < scanStart) break // not enough data for this fold

    // Filter signals by time window
    const isSignals = rawSignals.filter(
      s => s.signalTimeMs >= isStartMs && s.signalTimeMs < isEndMs,
    )
    const oosSignals = rawSignals.filter(
      s => s.signalTimeMs >= oosStartMs && s.signalTimeMs < oosEndMs,
    )

    if (isSignals.length < 3) {
      log.info('WFO fold skipped (too few IS signals)', { fold: foldIdx, isSignals: isSignals.length })
      continue
    }

    // Clip bars for IS — prevent data leakage into OOS
    const isBarEndIdx = findBarIdx(isEndMs)
    const isBarsClipped = bars5m.slice(0, isBarEndIdx)

    // Clip bars for OOS — prevent future data leakage
    const oosBarEndIdx = findBarIdx(oosEndMs)
    const oosBarsClipped = bars5m.slice(0, oosBarEndIdx)

    // IS: grid search
    let bestISCombo: ParamComboResult | null = null
    let bestISTrades: BacktestTradeResult[] = []

    for (const sl of slRange) {
      for (const tp of tpRange) {
        const { combo, trades } = evaluateCombo(sl, tp, isSignals, isBarsClipped, maxHoldBars)
        if (!bestISCombo || combo.expectancy > bestISCombo.expectancy) {
          bestISCombo = combo
          bestISTrades = trades
        }
      }
    }

    if (!bestISCombo) continue

    // IS Sharpe
    const isSummary = buildSummary(bestISTrades)
    const isSharpe = isSummary.sharpe

    // OOS: evaluate with IS-optimized params
    const { combo: oosCombo, trades: oosTrades } = evaluateCombo(
      bestISCombo.slMultiplier,
      bestISCombo.tpMultiplier,
      oosSignals,
      oosBarsClipped,
      maxHoldBars,
    )

    const oosSummary = buildSummary(oosTrades)
    const oosSharpe = oosSummary.sharpe

    folds.push({
      fold: foldIdx,
      isParams: bestISCombo,
      isSharpe,
      oosResult: oosCombo,
      oosSharpe,
      isSignalCount: isSignals.length,
      oosSignalCount: oosSignals.length,
    })

    allOosTrades.push(...oosTrades)

    log.info('WFO fold complete', {
      fold: foldIdx,
      isSL: bestISCombo.slMultiplier,
      isTP: bestISCombo.tpMultiplier,
      isExp: bestISCombo.expectancy,
      oosExp: oosCombo.expectancy,
      isSharpe: round(isSharpe, 4),
      oosSharpe: round(oosSharpe, 4),
    })
  }

  if (folds.length === 0) {
    throw new Error(`WFO produced 0 valid folds for ${symbol} — insufficient signal density`)
  }

  // 4. Calculate WFO Efficiency Ratio
  const meanISSharpe = folds.reduce((s, f) => s + f.isSharpe, 0) / folds.length
  const meanOOSSharpe = folds.reduce((s, f) => s + f.oosSharpe, 0) / folds.length
  const wfoER = meanISSharpe !== 0 ? meanOOSSharpe / meanISSharpe : 0

  // 5. Monte Carlo validation on concatenated OOS trades
  const monteCarlo = validateByMonteCarlo(allOosTrades, monteCarloIterations)

  // 6. Gate checks
  const wfoERPassed = wfoER >= 0.5
  const monteCarloP50Passed = monteCarlo.isValid
  const allPassed = wfoERPassed && monteCarloP50Passed

  log.info('WFO gates', {
    wfoER: round(wfoER, 4),
    wfoERPassed,
    mcP50: monteCarlo.p50Expectancy,
    monteCarloP50Passed,
    allPassed,
  })

  // 7. Use latest fold's best params as recommendation (if gates pass)
  // Folds are ordered most-recent-first (foldIdx 0 = latest)
  const latestFold = folds[0]
  const recommendedParams = allPassed ? latestFold.isParams : null

  // 8. Per-strategy WFO (use latest IS window for per-strategy optimization)
  let perStrategy: Record<string, ParamComboResult> | null = null
  if (allPassed) {
    const latestOosEndMs = endTime
    const latestIsEndMs = latestOosEndMs - oosDays * MS_PER_DAY
    const latestIsStartMs = latestIsEndMs - isDays * MS_PER_DAY
    const isSignals = rawSignals.filter(
      s => s.signalTimeMs >= latestIsStartMs && s.signalTimeMs < latestIsEndMs,
    )
    const isBarEndIdx = findBarIdx(latestIsEndMs)
    const isBarsClipped = bars5m.slice(0, isBarEndIdx)

    // Group by strategy and optimize each
    const stratGroups: Record<string, RawSignalEntry[]> = {}
    for (const sig of isSignals) {
      const key = sig.signal.strategy
      ;(stratGroups[key] ??= []).push(sig)
    }

    perStrategy = {}
    for (const [stratName, stratSignals] of Object.entries(stratGroups)) {
      if (stratSignals.length < 3) continue

      let best: ParamComboResult | null = null
      for (const sl of slRange) {
        for (const tp of tpRange) {
          const { combo } = evaluateCombo(sl, tp, stratSignals, isBarsClipped, maxHoldBars)
          if (!best || combo.expectancy > best.expectancy) {
            best = combo
          }
        }
      }
      if (best) perStrategy[stratName] = best
    }
  }

  // 9. Apply if gates pass
  let applied = false
  if (apply && allPassed && perStrategy && Object.keys(perStrategy).length > 0) {
    try {
      const configPath = resolve('data/config/strategy-params.json')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let existing: Record<string, any> = {}
      try {
        existing = JSON.parse(await readFile(configPath, 'utf-8'))
      } catch { /* file missing, start fresh */ }

      if (!existing.symbolOverrides || typeof existing.symbolOverrides !== 'object') {
        existing.symbolOverrides = {}
      }
      if (!existing.symbolOverrides[symbol] || typeof existing.symbolOverrides[symbol] !== 'object') {
        existing.symbolOverrides[symbol] = {}
      }

      for (const [stratName, best] of Object.entries(perStrategy)) {
        existing.symbolOverrides[symbol][stratName] = {
          ...(existing.symbolOverrides[symbol][stratName] ?? {}),
          slMultiplier: best.slMultiplier,
          tpMultiplier: best.tpMultiplier,
        }
      }

      await mkdir(dirname(configPath), { recursive: true })
      await writeFile(configPath, JSON.stringify(existing, null, 2))
      applied = true
      log.info('WFO params applied', { symbol })
    } catch (err) {
      log.warn('WFO failed to apply params', { error: String(err) })
    }
  }

  // 10. Build recommendation text
  const lines: string[] = [
    `${symbol} WFO (${totalDays}d, ${folds.length} folds, ${rawSignals.length} total signals):`,
  ]

  lines.push(`WFO Efficiency Ratio: ${round(wfoER, 4)} ${wfoERPassed ? '✅' : '❌ (< 0.5, overfitting)'}`)
  lines.push(`Monte Carlo p50: ${monteCarlo.p50Expectancy}% ${monteCarloP50Passed ? '✅' : '❌ (≤ 0, unreliable)'}`)
  lines.push(`Monte Carlo p5/p95: ${monteCarlo.p5Expectancy}% / ${monteCarlo.p95Expectancy}%`)

  if (recommendedParams) {
    lines.push(`Recommended: SL×${recommendedParams.slMultiplier} TP×${recommendedParams.tpMultiplier} (R:R ${recommendedParams.riskReward})`)
  } else {
    lines.push('⚠️ No params recommended — gates failed, keeping previous params')
  }

  for (const fold of folds) {
    lines.push(
      `  Fold ${fold.fold}: IS SL×${fold.isParams.slMultiplier}/TP×${fold.isParams.tpMultiplier} exp=${fold.isParams.expectancy}% → OOS exp=${fold.oosResult.expectancy}%`,
    )
  }

  if (applied) lines.push('✓ Params written to strategy-params.json')

  const recommendation = lines.join('\n')

  log.info('WFO complete', {
    symbol,
    folds: folds.length,
    wfoER: round(wfoER, 4),
    mcP50: monteCarlo.p50Expectancy,
    applied,
  })

  return {
    symbol,
    period: { start: new Date(scanStart).toISOString(), end: new Date(endTime).toISOString() },
    totalSignals: rawSignals.length,
    folds,
    wfoEfficiencyRatio: round(wfoER, 4),
    monteCarlo,
    recommendedParams,
    perStrategy,
    applied,
    recommendation,
    gates: { wfoERPassed, monteCarloP50Passed, allPassed },
  }
}

function round(v: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(v * f) / f
}
