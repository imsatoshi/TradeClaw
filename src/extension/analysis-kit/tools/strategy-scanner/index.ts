export { runStrategyScan } from './scanner.js'
export { detectMarketRegime } from './regime.js'
export type { MarketRegime } from './regime.js'
export { runBacktest, optimizeParams, batchOptimize } from './backtester.js'
export type { BacktestConfig, BacktestResult, BacktestTradeResult, BacktestSummary } from './backtester.js'
export type { OptimizeConfig, OptimizeResult, BatchOptimizeConfig, BatchOptimizeResult } from './backtester.js'
export { walkForwardOptimize } from './wfo.js'
export type { WFOConfig, WFOResult, WFOFoldResult } from './wfo.js'
export { validateByMonteCarlo } from './monte-carlo.js'
export type { MonteCarloResult } from './monte-carlo.js'
export type {
  StrategySignal,
  ScanResult,
  FundingRateInfo,
  SwingPoint,
  SignalDirection,
  SignalStrength,
  StrategyName,
} from './types.js'
