export type SignalDirection = 'long' | 'short'
export type SignalStrength = 'strong' | 'moderate' | 'weak'
export type StrategyName =
  | 'rsi_divergence' | 'ema_trend' | 'breakout_volume' | 'funding_fade'
  | 'bb_mean_revert' | 'structure_break'
  | 'pipeline'

/** Primary decision timeframe for each strategy. */
export const STRATEGY_TIMEFRAMES: Record<StrategyName, '4h' | '1h' | '15m'> = {
  rsi_divergence: '15m',
  ema_trend: '4h',
  breakout_volume: '4h',
  funding_fade: '4h',
  bb_mean_revert: '15m',
  structure_break: '15m',
  pipeline: '1h',
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

/** Multi-strategy confluence signal — only created when 2+ strategies agree on direction. */
export interface CompositeSignal {
  symbol: string
  direction: SignalDirection
  compositeScore: number          // 0-100, weighted sum
  regime: string                  // from regime detection
  strategies: StrategyName[]      // which strategies agree
  strategyCount: number           // how many agree (2+ required)
  avgConfidence: number           // average confidence across agreeing strategies
  bestEntry: number               // from highest-confidence signal
  bestSL: number                  // tightest SL (most conservative)
  bestTP: number                  // closest TP (most conservative)
  riskRewardRatio: number
  reasons: string[]               // individual strategy reasons
  grade: 'A' | 'B' | 'C'         // A: 3+ strategies, B: 2 strategies strong, C: 2 strategies moderate
}

export interface ScanResult {
  scannedAt: string           // ISO timestamp
  symbols: string[]
  timeframe: string
  signals: StrategySignal[]
  compositeSignals: CompositeSignal[]  // multi-strategy confluence
  errors: string[]
  sessionInfo: {
    currentHourUTC: number
    isOptimalSession: boolean
    sessionName: string       // 'asian' | 'london' | 'ny_overlap' | 'ny' | 'late'
    note: string
  }
  /** 4H OHLCV data used internally — exposed for regime detection reuse. */
  ohlcv4h?: Record<string, import('../../../archive-analysis/data/interfaces.js').MarketData[]>
  /** Dynamic strategy weights based on rolling win rates. */
  strategyWeights?: Record<string, import('./signal-log.js').StrategyWeight>
  /** Multi-factor pipeline signals — primary scoring output. */
  pipelineSignals?: PipelineSignal[]
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

// ==================== Multi-Factor Pipeline Types ====================

/** Per-dimension score with detail explanation. */
export interface DimensionScore {
  score: number
  max: number
  detail: string
  /** Raw indicator values for AI independent judgment (hybrid mode). */
  raw?: Record<string, number | string | boolean>
}

/** Multi-factor setup score — replaces independent strategy confluence. */
export interface SetupScore {
  symbol: string
  direction: SignalDirection
  totalScore: number           // 0-100
  regime: 'uptrend' | 'downtrend' | 'ranging'
  dimensions: {
    trend:        DimensionScore  // max 15
    momentum:     DimensionScore  // max 15
    acceleration: DimensionScore  // max 10
    structure:    DimensionScore  // max 20
    candle:       DimensionScore  // max 10
    volume:       DimensionScore  // max 10
    volatility:   DimensionScore  // max 10
    funding:      DimensionScore  // max 10
    crashRisk:    DimensionScore  // max 10 — multi-TF RSI_3 crash detection
  }
  /** Entry trigger result (null if score below threshold) */
  entry: EntryTrigger | null
}

/** Entry trigger classification */
export type TriggerType = 'bullish_confirm' | 'support_bounce' | 'bos_pullback' | 'liquidity_sweep'
  | 'bearish_confirm' | 'resistance_reject' | 'pending_zone'

/** Trade profile — drives SL width, TP ratios, DCA eligibility */
export type TradeProfile = 'trend' | 'reversal' | 'breakout' | 'scalp'

/** 1H entry trigger with precise SL/TP levels. */
export interface EntryTrigger {
  triggered: boolean
  entry: number               // suggested entry price
  stopLoss: number            // structure + ATR-based SL
  takeProfits: {
    tp1: { price: number; ratio: number }
    tp2: { price: number; ratio: number }
    tp3: { price: number; ratio: number }
  }
  riskReward: number
  reason: string
  /** How TP/SL were derived */
  tpSource?: 'structure' | 'atr'
  slSource?: 'structure' | 'atr' | 'dynamic'
  /** Classified trigger type */
  triggerType?: TriggerType
  /** Recommended trade profile based on trigger + regime */
  profile?: TradeProfile
}

/** Pending entry zone — setup qualifies but no immediate trigger. */
export interface PendingZone {
  symbol: string
  direction: SignalDirection
  setupScore: number
  idealEntry: number          // target entry price
  zoneHigh: number            // upper boundary
  zoneLow: number             // lower boundary
  stopLoss: number
  takeProfits: {
    tp1: { price: number; ratio: number }
    tp2: { price: number; ratio: number }
    tp3: { price: number; ratio: number }
  }
  riskReward: number
  reason: string
  createdAt: number           // Date.now()
  expiresAt: number           // TTL
}

/** Pipeline signal — the primary output of the new scoring system. */
export interface PipelineSignal {
  symbol: string
  direction: SignalDirection
  setupScore: number          // 0-100
  regime: string
  dimensions: SetupScore['dimensions']
  entry: EntryTrigger | null  // null if score < threshold or no trigger
  pendingZone?: PendingZone   // set when setup qualifies but no immediate trigger
  grade: 'A' | 'B' | 'C'     // A: ≥78, B: ≥threshold, C: below threshold
}
