/**
 * Crypto Trading Engine interface definitions
 *
 * Only defines interfaces and data types; implementation is provided by external trading services
 */

// ==================== Asset whitelist ====================

export let CRYPTO_ALLOWED_SYMBOLS: readonly string[] = [
  'BTC/USD',
  'ETH/USD',
  'SOL/USD',
  'BNB/USD',
  'APT/USD',
  'SUI/USD',
  'HYPE/USD',
  'DOGE/USD',
  'XRP/USD',
];

export function initCryptoAllowedSymbols(symbols: string[]): void {
  CRYPTO_ALLOWED_SYMBOLS = Object.freeze([...symbols]);
}

// ==================== Default leverage ====================

/** Strategy-configured leverage, set during engine init. Defaults to 1 (spot). */
export let CRYPTO_DEFAULT_LEVERAGE = 1;

export function initCryptoDefaultLeverage(leverage: number): void {
  CRYPTO_DEFAULT_LEVERAGE = leverage;
}

// ==================== Max open trades ====================

/** Max concurrent open trades, set during engine init from Freqtrade show_config. Defaults to 5. */
export let CRYPTO_MAX_OPEN_TRADES = 5;

export function initCryptoMaxOpenTrades(max: number): void {
  CRYPTO_MAX_OPEN_TRADES = max;
}

export type CryptoAllowedSymbol = string;

// ==================== Core interfaces ====================

export interface ICryptoTradingEngine {
  placeOrder(order: CryptoPlaceOrderRequest, currentTime?: Date): Promise<CryptoOrderResult>;
  getPositions(): Promise<CryptoPosition[]>;
  getOrders(): Promise<CryptoOrder[]>;
  getAccount(): Promise<CryptoAccountInfo>;
  cancelOrder(orderId: string): Promise<boolean>;
  adjustLeverage(symbol: string, newLeverage: number): Promise<{ success: boolean; error?: string }>;
}

// ==================== Orders ====================

export interface CryptoPlaceOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stoploss';
  size?: number;
  usd_size?: number;
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
}

export interface CryptoOrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  message?: string;
  filledPrice?: number;
  filledSize?: number;
}

export interface CryptoOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  size: number;
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  filledPrice?: number;
  filledSize?: number;
  filledAt?: Date;
  createdAt: Date;
  rejectReason?: string;
}

// ==================== Positions ====================

export interface CryptoPosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  liquidationPrice: number;
  markPrice: number;
  unrealizedPnL: number;
  positionValue: number;
  // Strategy context (optional, provider-specific)
  enterTag?: string;           // Strategy entry signal tag
  grindCount?: number;         // DCA/grinding count
  partialExitCount?: number;   // Partial take-profit count
  profitRatio?: number;        // Current profit ratio (decimal, e.g. 0.035 = 3.5%)
  // Risk detail fields (from Freqtrade)
  stopLossPrice?: number;      // Current stop-loss price (stop_loss_abs)
  stopLossDistance?: number;    // Stop-loss distance ratio (e.g. -0.05 = 5%)
  fundingFees?: number;        // Accumulated funding fees (positive=received, negative=paid)
}

// ==================== Account ====================

export interface CryptoAccountInfo {
  balance: number;
  totalMargin: number;
  unrealizedPnL: number;
  equity: number;
  realizedPnL: number;
  totalPnL: number;
}

// ==================== Precision ====================

export interface SymbolPrecision {
  price: number;
  size: number;
}

// ==================== Risk management defaults ====================

/** Max single trade stake as % of equity (hard limit, enforced in operation-dispatcher) */
export const MAX_STAKE_PERCENT_OF_EQUITY = 40;

/** Stop opening new positions if available balance < this ratio of equity (hard limit) */
export const MIN_AVAILABLE_BALANCE_RATIO = 0.3;
