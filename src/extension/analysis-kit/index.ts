// Extension adapter — re-exports from both old and new locations for backward compatibility
export { createAnalysisTools } from '../archive-analysis/adapter';

// Sandbox (renamed to KlineStore, re-exported as Sandbox for backward compat)
export { KlineStore as Sandbox } from '../archive-analysis/kline/KlineStore';

// Data providers (moved to archive-analysis/data/)
export type { IMarketDataProvider, INewsProvider } from '../archive-analysis/data/interfaces';
export { RealMarketDataProvider } from '../archive-analysis/data/RealMarketDataProvider';
export { RealNewsProvider } from '../archive-analysis/data/RealNewsProvider';
export { MockDataProvider } from '../archive-analysis/data/MockDataProvider';
export { fetchRealtimeData } from '../archive-analysis/data/DotApiClient';
export { fetchExchangeOHLCV } from '../archive-analysis/data/ExchangeClient';
export { fetchFundingRates } from '../archive-analysis/data/FundingRateClient';
export { runStrategyScan } from './tools/strategy-scanner/index';
export { detectMarketRegime } from './tools/strategy-scanner/index';
export { runBacktest, optimizeParams, batchOptimize } from './tools/strategy-scanner/index';
export { walkForwardOptimize } from './tools/strategy-scanner/index';
export type { MarketRegime } from './tools/strategy-scanner/index';
export type { BacktestConfig, BacktestResult, OptimizeConfig, OptimizeResult } from './tools/strategy-scanner/index';
export type { WFOConfig, WFOResult } from './tools/strategy-scanner/index';
export type { MonteCarloResult } from './tools/strategy-scanner/index';
export type { StrategySignal, ScanResult, FundingRateInfo } from './tools/strategy-scanner/index';
export { fetchHistoricalOHLCV } from '../archive-analysis/data/ExchangeClient';
