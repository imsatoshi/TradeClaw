/**
 * Multi-strategy confluence scorer.
 *
 * Groups individual strategy signals by (symbol, direction) and only
 * surfaces opportunities where 2+ independent strategies agree.
 * Uses the most conservative SL/TP across agreeing strategies.
 */

import type { StrategySignal, CompositeSignal, StrategyName } from './types.js'
import type { MarketRegime } from './regime.js'
import type { StrategyWeight } from './signal-log.js'

/** Minimum composite score to surface a signal. */
const MIN_COMPOSITE_SCORE = 60

/**
 * Compute confluence signals from individual strategy outputs.
 *
 * @param signals    - All strategy signals (already regime-filtered + MTF-filtered)
 * @param regimeMap  - Regime for each symbol (keyed by symbol)
 * @returns Composite signals with 2+ strategy agreement, sorted by score descending
 */
export function computeConfluence(
  signals: StrategySignal[],
  regimeMap: Record<string, MarketRegime>,
  weights?: Record<string, StrategyWeight>,
): CompositeSignal[] {
  // Pre-filter: drop signals from muted strategies
  const activeSignals = weights
    ? signals.filter(s => !weights[s.strategy]?.muted)
    : signals

  // Group signals by (symbol, direction)
  const groups = new Map<string, StrategySignal[]>()
  for (const signal of activeSignals) {
    const key = `${signal.symbol}|${signal.direction}`
    const group = groups.get(key)
    if (group) {
      group.push(signal)
    } else {
      groups.set(key, [signal])
    }
  }

  const composites: CompositeSignal[] = []

  for (const [, group] of groups) {
    if (group.length < 2) continue

    // Deduplicate by strategy name — keep highest confidence per strategy
    const byStrategy = new Map<StrategyName, StrategySignal>()
    for (const sig of group) {
      const existing = byStrategy.get(sig.strategy)
      if (!existing || sig.confidence > existing.confidence) {
        byStrategy.set(sig.strategy, sig)
      }
    }

    const uniqueSignals = [...byStrategy.values()]
    if (uniqueSignals.length < 2) continue

    const symbol = uniqueSignals[0].symbol
    const direction = uniqueSignals[0].direction
    const strategies = uniqueSignals.map(s => s.strategy)

    // Weighted average confidence (using strategy weights if available)
    let avgConfidence: number
    if (weights) {
      let weightedSum = 0
      let weightSum = 0
      for (const sig of uniqueSignals) {
        const w = weights[sig.strategy]?.weight ?? 1.0
        weightedSum += sig.confidence * w
        weightSum += w
      }
      avgConfidence = weightSum > 0 ? weightedSum / weightSum : 0
    } else {
      const confidences = uniqueSignals.map(s => s.confidence)
      avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length
    }

    // Weighted composite score — base = weighted average confidence
    // Note: regime alignment is already handled by regime filter's confidence
    // adjustments (+/-10), so no additional bonus is applied here.
    let compositeScore = avgConfidence
    const regime = regimeMap[symbol]
    const regimeName = regime?.regime ?? 'ranging'

    // Strategy count bonus: +5 per strategy beyond 2
    compositeScore = Math.min(100, compositeScore + (uniqueSignals.length - 2) * 5)

    if (compositeScore < MIN_COMPOSITE_SCORE) continue

    // Pick best entry from highest-confidence signal
    const bestSignal = uniqueSignals.reduce((a, b) => a.confidence > b.confidence ? a : b)

    // Most conservative SL: for longs, highest SL; for shorts, lowest SL
    let bestSL: number
    if (direction === 'long') {
      bestSL = Math.max(...uniqueSignals.map(s => s.stopLoss))
    } else {
      bestSL = Math.min(...uniqueSignals.map(s => s.stopLoss))
    }

    // Most conservative TP: for longs, lowest TP; for shorts, highest TP
    let bestTP: number
    if (direction === 'long') {
      bestTP = Math.min(...uniqueSignals.map(s => s.takeProfit))
    } else {
      bestTP = Math.max(...uniqueSignals.map(s => s.takeProfit))
    }

    // R:R ratio
    const risk = Math.abs(bestSignal.entry - bestSL)
    const reward = Math.abs(bestTP - bestSignal.entry)
    const riskRewardRatio = risk > 0 ? Math.round((reward / risk) * 10) / 10 : 0

    // Grade
    let grade: CompositeSignal['grade']
    if (uniqueSignals.length >= 3) {
      grade = 'A'
    } else if (avgConfidence >= 70) {
      grade = 'B'
    } else {
      grade = 'C'
    }

    composites.push({
      symbol,
      direction,
      compositeScore: Math.round(compositeScore),
      regime: regimeName,
      strategies,
      strategyCount: uniqueSignals.length,
      avgConfidence: Math.round(avgConfidence),
      bestEntry: bestSignal.entry,
      bestSL,
      bestTP,
      riskRewardRatio,
      reasons: uniqueSignals.map(s => s.reason),
      grade,
    })
  }

  // Sort by composite score descending
  composites.sort((a, b) => b.compositeScore - a.compositeScore)
  return composites
}
