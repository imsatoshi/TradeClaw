/**
 * Monte Carlo bootstrap validation for backtest results.
 *
 * Resamples trades with replacement to estimate the distribution of expectancy
 * and max drawdown. Used as a statistical gate: if the median (p50) expectancy
 * is <= 0, the optimized parameters are rejected as unreliable.
 *
 * Reference: Ernest Chan (2013) — Algorithmic Trading, simulation-based optimization.
 */

import type { BacktestTradeResult } from './backtester.js'

export interface MonteCarloResult {
  /** 5th percentile expectancy — pessimistic estimate */
  p5Expectancy: number
  /** Median expectancy — central estimate */
  p50Expectancy: number
  /** 95th percentile expectancy — optimistic estimate */
  p95Expectancy: number
  /** 5th percentile max drawdown (worst case, negative number) */
  p5MaxDrawdown: number
  /** Number of iterations run */
  iterations: number
  /** Whether the result passes validation (p50 > 0) */
  isValid: boolean
}

/**
 * Run Monte Carlo bootstrap validation on a set of backtest trades.
 *
 * Algorithm:
 * 1. From the original trade list, sample N trades with replacement (N = original length)
 * 2. Compute expectancy and max drawdown for the resampled set
 * 3. Repeat `iterations` times
 * 4. Return percentile distribution
 *
 * @param trades    — backtest trade results to resample
 * @param iterations — number of bootstrap iterations (default 1000)
 * @returns MonteCarloResult with percentile distribution
 */
export function validateByMonteCarlo(
  trades: BacktestTradeResult[],
  iterations = 1000,
): MonteCarloResult {
  if (trades.length < 5) {
    return {
      p5Expectancy: 0,
      p50Expectancy: 0,
      p95Expectancy: 0,
      p5MaxDrawdown: 0,
      iterations: 0,
      isValid: false,
    }
  }

  const n = trades.length
  const expectancies: number[] = []
  const maxDrawdowns: number[] = []

  for (let iter = 0; iter < iterations; iter++) {
    // Resample with replacement
    const sampled: BacktestTradeResult[] = []
    for (let j = 0; j < n; j++) {
      sampled.push(trades[Math.floor(Math.random() * n)])
    }

    // Compute expectancy: winRate * avgWin - (1-winRate) * |avgLoss|
    const wins = sampled.filter(t => t.pnlPercent > 0)
    const losses = sampled.filter(t => t.pnlPercent < 0)
    const wr = wins.length / n
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length : 0
    const expectancy = wr * avgWin - (1 - wr) * Math.abs(avgLoss)
    expectancies.push(expectancy)

    // Compute max drawdown from cumulative PnL
    let cumPnl = 0
    let peak = 0
    let maxDD = 0
    for (const t of sampled) {
      cumPnl += t.pnlPercent
      if (cumPnl > peak) peak = cumPnl
      const dd = cumPnl - peak
      if (dd < maxDD) maxDD = dd
    }
    maxDrawdowns.push(maxDD)
  }

  expectancies.sort((a, b) => a - b)
  maxDrawdowns.sort((a, b) => a - b)

  const p5Exp = expectancies[Math.floor(iterations * 0.05)]
  const p50Exp = expectancies[Math.floor(iterations * 0.50)]
  const p95Exp = expectancies[Math.floor(iterations * 0.95)]
  const p5DD = maxDrawdowns[Math.floor(iterations * 0.05)] // worst 5%

  return {
    p5Expectancy: round(p5Exp, 4),
    p50Expectancy: round(p50Exp, 4),
    p95Expectancy: round(p95Exp, 4),
    p5MaxDrawdown: round(p5DD, 4),
    iterations,
    isValid: p50Exp > 0,
  }
}

function round(v: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(v * f) / f
}
