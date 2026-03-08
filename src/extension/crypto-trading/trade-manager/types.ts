/**
 * TradePlan — multi-level TP/SL trade lifecycle types.
 *
 * State machine: pending → active → partial → completed | cancelled | error
 */

export type TradePlanStatus = 'pending' | 'active' | 'partial' | 'completed' | 'cancelled' | 'error'

/** Trade profile — drives SL width, TP ratios, DCA eligibility, trailing behavior */
export type TradeProfile = 'trend' | 'reversal' | 'breakout' | 'scalp'

export interface DcaLayer {
  layer: number
  triggerPrice: number
  stakeAmount: number
  status: 'pending' | 'triggered' | 'filled' | 'exited' | 'stopped'
  filledPrice?: number
  filledAmount?: number
  filledAt?: string
  exitPrice?: number
  exitAt?: string
  /** Freqtrade trade_id for this DCA layer (each layer is a separate trade) */
  freqtradeTradeId?: number
}

export interface DcaConfig {
  enabled: boolean
  maxLayers: number
  hardStopPrice: number
  tpProfitThreshold: number
  layers: DcaLayer[]
  totalDcaAmount?: number
  avgEntryPrice?: number
}

export interface TakeProfitLevel {
  /** TP level number, starting from 1 */
  level: number
  /** Target exit price */
  price: number
  /** Portion of position to close (0-1). All TP levels should sum to 1.0 */
  sizeRatio: number
  /** Status of this TP level */
  status: 'pending' | 'placed' | 'filled' | 'cancelled'
  /** Freqtrade order ID (if placed) */
  orderId?: string
  /** Actual fill price */
  filledPrice?: number
  /** ISO timestamp of fill */
  filledAt?: string
  /** Number of failed placement attempts (for retry logic) */
  retryCount?: number
}

export interface StopLoss {
  price: number
  /** 'monitoring' = TradeManager actively watches price and will forceExit on breach */
  status: 'pending' | 'monitoring' | 'placed' | 'filled' | 'cancelled'
  /** @deprecated SL no longer placed via exchange. Kept for history compatibility. */
  orderId?: string
  filledPrice?: number
  filledAt?: string
}

/** Trailing stop configuration */
export interface TrailingStopConfig {
  /** Trailing distance — SL follows price at this distance */
  distance: number
  /** Distance type:
   * 'fixed'      = absolute price distance
   * 'percent'    = % of price
   * 'chandelier' = distance is ATR multiplier, anchored to period high/low
   */
  type: 'fixed' | 'percent' | 'chandelier'
  /** Lookback bars for chandelier mode (default 14) */
  lookbackBars?: number
}

/** P&L snapshot computed dynamically each tick (not persisted) */
export interface TradePlanPnL {
  /** Current market price */
  currentPrice: number
  /** Unrealized P&L in USDT (entire remaining position) */
  unrealizedPnl: number
  /** Unrealized P&L as percentage of entry */
  unrealizedPnlPct: number
  /** Realized P&L from filled TPs in USDT */
  realizedPnl: number
  /** Current risk:reward ratio — distance to SL vs distance to next TP */
  riskRewardRatio: number | null
  /** Highest favorable price since entry (for trailing stop tracking) */
  peakPrice: number
  /** Maximum adverse excursion (worst unrealized loss since entry) */
  maxDrawdown: number
}

export interface TradePlan {
  id: string
  symbol: string
  direction: 'long' | 'short'
  /** Freqtrade trade_id (populated after entry fill) */
  freqtradeTradeId?: number
  /** Actual entry fill price */
  entryPrice?: number
  /** Position size in coins */
  positionSize?: number
  /** Leverage used (from Freqtrade trade) */
  leverage?: number
  takeProfits: TakeProfitLevel[]
  stopLoss: StopLoss
  status: TradePlanStatus
  /** AI-provided trade rationale */
  reason?: string
  createdAt: string
  updatedAt: string
  /** Error message when status === 'error' */
  errorMessage?: string

  // --- Auto SL features ---

  /** Auto-move SL to breakeven (entry price) after first TP fills */
  autoBreakeven?: boolean
  /** Trailing stop: SL follows price at a fixed distance */
  trailingStop?: TrailingStopConfig
  /** Highest favorable price since entry (tracked for trailing stop) */
  peakPrice?: number
  /** Maximum drawdown observed (worst unrealized loss %) */
  maxDrawdown?: number
  /** Realized P&L from filled TPs (accumulated, persisted) */
  realizedPnl?: number

  // --- Signal profile ---

  /** Trade profile — determines SL/TP/DCA strategy */
  profile?: TradeProfile
  /** DCA configuration (only for 'reversal' profile) */
  dca?: DcaConfig

  // --- Entry context (for DCA gating) ---

  /** Market regime at entry time (for DCA regime check) */
  entryRegime?: 'uptrend' | 'downtrend' | 'ranging'
  /** Setup score at entry time (DCA disabled below 75) */
  entryScore?: number

  // --- Progressive protection ---

  /** ATR(14, 1H) at entry time — used for progressive SL stages */
  atrAtEntry?: number
  /** Current progressive protection stage reached (0-4) */
  progressiveStage?: number

  // --- Time decay ---

  /** Auto-tighten SL after trade sits too long without TP1 fill */
  timeDecay?: {
    /** Hours before tightening (default 8) */
    hoursToTighten: number
    /** Percentage to tighten SL distance (default 50 — moves SL to midpoint) */
    tightenPercent: number
  }
  /** Whether time-decay SL tightening has already been applied */
  timeDecayApplied?: boolean

  // --- SL proximity warning ---
  /** Whether SL proximity warning has been emitted (reset when SL moves) */
  slWarningEmitted?: boolean
}
