// Extension adapter
export { createAnalysisTools } from './adapter';

// Sandbox
export { Sandbox } from './sandbox/Sandbox';
export type { SandboxConfig } from './sandbox/interfaces';

// Data providers
export type { IMarketDataProvider, INewsProvider } from './data/interfaces';
export { RealMarketDataProvider } from './data/RealMarketDataProvider';
export { RealNewsProvider } from './data/RealNewsProvider';
export { MockDataProvider } from './data/MockDataProvider';
export { fetchRealtimeData } from './data/DotApiClient';
export { fetchExchangeOHLCV } from './data/ExchangeClient';
export { fetchFundingRates } from './data/FundingRateClient';
export { runStrategyScan } from './tools/strategy-scanner/index';
export { detectMarketRegime } from './tools/strategy-scanner/index';
export { runBacktest, optimizeParams, batchOptimize } from './tools/strategy-scanner/index';
export type { MarketRegime } from './tools/strategy-scanner/index';
export type { BacktestConfig, BacktestResult, OptimizeConfig, OptimizeResult } from './tools/strategy-scanner/index';
export type { StrategySignal, ScanResult, FundingRateInfo } from './tools/strategy-scanner/index';
export { fetchHistoricalOHLCV } from './data/ExchangeClient';
