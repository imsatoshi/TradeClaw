export type SignalDirection = 'long' | 'short'
export type SignalStrength = 'strong' | 'moderate' | 'weak'
export type StrategyName =
  | 'rsi_divergence' | 'ema_trend' | 'breakout_volume' | 'funding_fade'
  | 'bb_mean_revert' | 'structure_break'

/** Primary decision timeframe for each strategy. */
export const STRATEGY_TIMEFRAMES: Record<StrategyName, '4h' | '15m'> = {
  rsi_divergence: '4h',
  ema_trend: '4h',
  breakout_volume: '4h',
  funding_fade: '4h',
  bb_mean_revert: '15m',
  structure_break: '15m',
}

export interface StrategySignal {
  strategy: StrategyName
  symbol: string
  direction: SignalDirection
  strength: SignalStrength
  confidence: number          // 0-100
  timeframe: string           // '4h'
  entry: number               // suggested entry (current close)
  stopLoss: number            // ATR-based stop loss
  takeProfit: number          // R:R based target
  riskRewardRatio: number
  details: Record<string, number | string>
  reason: string              // human-readable signal reason
}

export interface ScanResult {
  scannedAt: string           // ISO timestamp
  symbols: string[]
  timeframe: string
  signals: StrategySignal[]
  errors: string[]
  sessionInfo: {
    currentHourUTC: number
    isOptimalSession: boolean
    sessionName: string       // 'asian' | 'london' | 'ny_overlap' | 'ny' | 'late'
    note: string
  }
  /** 4H OHLCV data used internally — exposed for regime detection reuse. */
  ohlcv4h?: Record<string, import('../../../archive-analysis/data/interfaces.js').MarketData[]>
}

export interface FundingRateInfo {
  symbol: string
  fundingRate: number         // e.g. 0.0001 = 0.01%
  fundingRatePercent: string  // human-readable "0.0100%"
  markPrice: number
  indexPrice: number
  nextFundingTime: number     // Unix ms
  nextFundingTimeISO: string
}

export interface SwingPoint {
  index: number
  price: number
  rsi: number
  volume: number
}
