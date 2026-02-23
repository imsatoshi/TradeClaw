/**
 * TradePlan — multi-level TP/SL trade lifecycle types.
 *
 * State machine: pending → active → partial → completed | cancelled | error
 */

export type TradePlanStatus = 'pending' | 'active' | 'partial' | 'completed' | 'cancelled' | 'error'

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
}

export interface StopLoss {
  price: number
  status: 'pending' | 'placed' | 'filled' | 'cancelled'
  orderId?: string
  filledPrice?: number
  filledAt?: string
}

/** Trailing stop configuration */
export interface TrailingStopConfig {
  /** Trailing distance — SL follows price at this distance */
  distance: number
  /** Distance type: 'fixed' = absolute price distance, 'percent' = % of price */
  type: 'fixed' | 'percent'
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
}
