/**
 * Freqtrade API types
 *
 * Based on Freqtrade REST API schema
 * https://www.freqtrade.io/en/stable/rest-api/
 */

// ============ Trade/Order Types ============

export interface FreqtradeOrderRequest {
  pair: string;
  side: 'long' | 'short';
  /** Stake amount in stake currency (USDT). Field name must be stakeamount per Freqtrade API. */
  stakeamount?: number;
  price?: number;
  ordertype: 'market' | 'limit' | 'stop_loss' | 'stop_loss_limit';
  stoploss?: number;
  entry_tag?: string;
  leverage?: number;
}

export interface FreqtradeOrderResponse {
  order_id: string;
  pair: string;
  status: 'open' | 'closed' | 'canceled';
  amount: number;
  filled: number;
  remaining: number;
  price: number;
  average?: number;
  side: 'buy' | 'sell';
  type: string;
  open_date: string;
  close_date?: string;
}

// ============ Position Types ============

export interface FreqtradeTrade {
  trade_id: number;
  /** Pair in futures format, e.g. "ZEC/USDT:USDT" */
  pair: string;
  base_currency?: string;
  quote_currency?: string;
  is_open: boolean;
  /** true = short position, false = long position (API uses this instead of "side") */
  is_short: boolean;
  open_rate: number;
  close_rate?: number;
  /** Current market price (returned by /api/v1/status for open trades) */
  current_rate?: number;
  amount: number;
  stake_amount: number;
  /** Total value of the trade at open (including leverage) */
  open_trade_value?: number;
  profit_ratio: number;
  profit_abs: number;
  /** Profit percentage (profit_ratio * 100) */
  profit_pct?: number;
  open_date: string;
  close_date?: string;
  leverage?: number;
  liquidation_price?: number;
  trading_mode?: 'spot' | 'margin' | 'futures';
  /** Accumulated funding fees (futures only) */
  funding_fees?: number;
  /** Whether this trade has a pending (open) order on the exchange */
  has_open_orders?: boolean;
  /** Distance to current stoploss */
  stoploss_current_dist?: number;
  stoploss_current_dist_ratio?: number;
  stop_loss_abs?: number;
  /** Sub-orders for this trade (returned by /api/v1/status when orders are present) */
  orders?: FreqtradeTradeOrder[];
  // Strategy state (from /api/v1/status)
  enter_tag?: string;             // Entry signal tag (e.g. "1", "41", "120", "force_entry")
  exit_reason?: string;           // Exit reason
  filled_entry_orders?: number;   // Filled entry order count (DCA layers)
  filled_exit_orders?: number;    // Filled exit order count (partial take-profit count)
  nr_of_successful_entries?: number;
  nr_of_successful_exits?: number;
  amount_requested?: number;      // Original entry amount before partial exits
  realized_profit?: number;       // Accumulated realized profit from partial exits
}

export interface FreqtradeTradeOrder {
  order_id: string;
  status: 'open' | 'closed' | 'canceled';
  order_type: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  filled: number;
  remaining: number;
  ft_order_side: 'buy' | 'sell' | 'stoploss';
  order_date: string;
}

export interface FreqtradePosition {
  pair: string;
  side: 'long' | 'short';
  amount: number;
  entry_price: number;
  mark_price: number;
  leverage: number;
  unrealized_pnl: number;
  margin: number;
  liquidation_price?: number;
}

// ============ Account/Balance Types ============

export interface FreqtradeBalance {
  currency: string;
  free: number;
  used: number;
  balance: number;
  est_stake?: number;
}

export interface FreqtradeBalanceResponse {
  currencies: FreqtradeBalance[];
  total: number;
  total_stake: number;
  stake: string;
}

export interface FreqtradeProfitResponse {
  profit_closed_coin: number;
  profit_closed_percent: number;
  profit_closed_fiat: number;
  profit_all_coin: number;
  profit_all_percent: number;
  profit_all_fiat: number;
  trade_count: number;
  closed_trade_count: number;
  first_trade_date?: string;
  latest_trade_date?: string;
  avg_duration: string;
  best_pair?: string;
  win_rate: number;
}

// ============ Status Types ============

/** Response from /api/v1/show_config */
export interface FreqtradeShowConfigResponse {
  version: string;
  strategy?: string;
  strategy_version?: string;
  dry_run: boolean;
  stake_currency?: string;
  stake_amount?: number;
  available_capital?: number;
  trading_mode?: 'spot' | 'margin' | 'futures';
  max_open_trades?: number;
  stoploss?: number;
  timeframe?: string;
  exchange?: string;
  state?: string;
}

export interface FreqtradePingResponse {
  status: 'pong';
}

// ============ Whitelist Types ============

export interface FreqtradeWhitelistResponse {
  whitelist: string[];
  method: string;
  length: number;
}

// ============ Blacklist Types ============

export interface FreqtradeBlacklistResponse {
  blacklist: string[];
  blacklist_length: number;
  method: string;
}

// ============ Lock Types ============

export interface FreqtradeLockResponse {
  lock_id: number;
  pair: string;
  until: string;
  side: string;
  reason: string;
  active: boolean;
}
