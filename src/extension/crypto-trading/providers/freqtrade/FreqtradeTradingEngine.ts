
/**
 * Freqtrade Trading Engine
 *
 * Implementation of ICryptoTradingEngine that connects to a local Freqtrade instance
 * via its REST API. This allows OpenAlice to leverage Freqtrade's strategy execution,
 * risk management, and position tracking while adding AI-driven decision making.
 */

import type {
  ICryptoTradingEngine,
  CryptoPlaceOrderRequest,
  CryptoOrderResult,
  CryptoPosition,
  CryptoOrder,
  CryptoAccountInfo,
} from '../../interfaces.js';
import type {
  FreqtradeOrderRequest,
  FreqtradeOrderResponse,
  FreqtradeTrade,
  FreqtradeBalanceResponse,
  FreqtradeShowConfigResponse,
  FreqtradeWhitelistResponse,
} from './types.js';
import { CRYPTO_ALLOWED_SYMBOLS, initCryptoAllowedSymbols } from '../../interfaces.js';

// Store original proxy settings to restore later
let originalNoProxy: string | undefined;

export interface FreqtradeEngineConfig {
  /** Freqtrade API URL (e.g., http://localhost:8080) */
  url: string;
  /** API username */
  username: string;
  /** API password */
  password: string;
  /** Default stake amount in stake currency (e.g., USDT) */
  defaultStakeAmount?: number;
}

/**
 * Normalize Freqtrade futures pair to standard format.
 * "ZEC/USDT:USDT" → "ZEC/USDT"
 * "BTC/USDT" → "BTC/USDT" (no-op for spot)
 */
function normalizePair(pair: string): string {
  const colonIdx = pair.indexOf(':');
  return colonIdx > 0 ? pair.slice(0, colonIdx) : pair;
}

/**
 * Convert standard symbol to Freqtrade format.
 * In futures mode, Freqtrade may need "ZEC/USDT:USDT" but /api/v1/forceenter
 * accepts "ZEC/USDT" and resolves it automatically.
 */
function toFreqtradeSymbol(symbol: string): string {
  return symbol;
}

/**
 * Map Freqtrade order status to OpenAlice order status
 */
function mapOrderStatus(status: string): CryptoOrder['status'] {
  switch (status) {
    case 'closed':
      return 'filled';
    case 'open':
      return 'pending';
    case 'canceled':
      return 'cancelled';
    default:
      return 'rejected';
  }
}

export class FreqtradeTradingEngine implements ICryptoTradingEngine {
  private config: FreqtradeEngineConfig;
  private authHeader: string;
  private initialized = false;
  private stakeCurrency = 'USDT';

  // Cache for order symbol mapping (needed for cancelOrder)
  private orderSymbolCache = new Map<string, string>();

  constructor(config: FreqtradeEngineConfig) {
    this.config = config;
    this.authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  }

  async init(): Promise<void> {
    // Verify connection with a ping first (no auth required)
    await this.get<{ status: string }>('/api/v1/ping');

    // Get bot config (requires auth — validates credentials)
    const showConfig = await this.fetchShowConfig();
    this.stakeCurrency = showConfig.stake_currency || 'USDT';

    // Fetch whitelist from Freqtrade and sync with OpenAlice
    // Normalize futures format: "ZEC/USDT:USDT" → "ZEC/USDT"
    const rawWhitelist = await this.fetchWhitelist();
    const whitelist = rawWhitelist.map(normalizePair);
    if (whitelist.length > 0) {
      initCryptoAllowedSymbols(whitelist);
      console.log(`freqtrade: synced ${whitelist.length} pairs from whitelist: ${whitelist.join(', ')}`);
    }

    this.initialized = true;
    console.log(`freqtrade trading engine: connected to ${this.config.url}`);
    console.log(`freqtrade: strategy=${showConfig.strategy}, stake=${this.stakeCurrency}, dry_run=${showConfig.dry_run}, mode=${showConfig.trading_mode || 'spot'}`);
  }

  async close(): Promise<void> {
    // Nothing to clean up for HTTP client
    this.initialized = false;
  }

  // ==================== ICryptoTradingEngine ====================

  async placeOrder(order: CryptoPlaceOrderRequest, _currentTime?: Date): Promise<CryptoOrderResult> {
    this.ensureInit();

    // Check if symbol is allowed (using Freqtrade's whitelist)
    if (!CRYPTO_ALLOWED_SYMBOLS.includes(order.symbol)) {
      return {
        success: false,
        error: `Symbol ${order.symbol} is not in Freqtrade whitelist`,
      };
    }

    const freqtradeSymbol = toFreqtradeSymbol(order.symbol);

    // Calculate stake amount from size or usd_size
    let stakeAmount = order.usd_size;
    if (!stakeAmount && order.size) {
      // For Freqtrade, we use stake amount instead of size
      // Size will be calculated by Freqtrade based on price
      stakeAmount = order.size * (order.price || 0);
    }

    if (!stakeAmount) {
      stakeAmount = this.config.defaultStakeAmount;
    }

    if (!stakeAmount || stakeAmount <= 0) {
      return {
        success: false,
        error: 'Either size, usd_size, or defaultStakeAmount must be provided',
      };
    }

    const payload: FreqtradeOrderRequest = {
      pair: freqtradeSymbol,
      side: order.side,
      ordertype: order.type,
      amount: stakeAmount,
    };

    if (order.type === 'limit' && order.price) {
      payload.price = order.price;
    }

    try {
      // Freqtrade uses /api/v1/forceenter for manual trade entry (not /api/v1/trade)
      const result = await this.post<FreqtradeOrderResponse>('/api/v1/forceenter', payload);

      // Cache order symbol mapping
      if (result.order_id) {
        this.orderSymbolCache.set(result.order_id, freqtradeSymbol);
      }

      const status = mapOrderStatus(result.status);

      return {
        success: true,
        orderId: result.order_id,
        message: `Order ${result.order_id} ${status}`,
        filledPrice: result.average || (status === 'filled' ? result.price : undefined),
        filledSize: result.filled || (status === 'filled' ? result.amount : undefined),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getPositions(): Promise<CryptoPosition[]> {
    this.ensureInit();

    // Get open trades from Freqtrade — /api/v1/status returns current_rate for open trades
    const trades = await this.get<FreqtradeTrade[]>('/api/v1/status');

    const positions: CryptoPosition[] = [];

    for (const trade of trades) {
      if (!trade.is_open) continue;

      // current_rate is the live market price from Freqtrade (critical for PnL)
      // close_rate is only set when a trade is closed — never use it for open positions
      const currentPrice = trade.current_rate || trade.open_rate;

      // Freqtrade uses is_short (boolean) instead of side ('long'|'short')
      const side = trade.is_short ? 'short' : 'long';

      // Normalize futures pair format: "ZEC/USDT:USDT" → "ZEC/USDT"
      const symbol = normalizePair(trade.pair);

      positions.push({
        symbol,
        side,
        size: trade.amount,
        entryPrice: trade.open_rate,
        leverage: trade.leverage || 1,
        margin: trade.stake_amount,
        liquidationPrice: trade.liquidation_price || 0,
        markPrice: currentPrice,
        unrealizedPnL: trade.profit_abs,
        positionValue: trade.amount * currentPrice,
      });
    }

    return positions;
  }

  async getOrders(): Promise<CryptoOrder[]> {
    this.ensureInit();

    // Get all trades and convert to orders
    // Freqtrade returns { trades: [...] } not just array
    const response = await this.get<{ trades?: FreqtradeTrade[] }>('/api/v1/trades');
    const trades = response.trades || [];

    const orders: CryptoOrder[] = [];

    for (const trade of trades) {
      const symbol = normalizePair(trade.pair);

      // Cache order symbol mapping
      if (trade.trade_id) {
        this.orderSymbolCache.set(String(trade.trade_id), symbol);
      }

      // In Freqtrade, an "open" trade is an active position (already filled entry),
      // not a pending order waiting to be filled.
      orders.push({
        id: String(trade.trade_id),
        symbol,
        side: trade.is_short ? 'sell' : 'buy',
        type: 'market',
        size: trade.amount,
        price: trade.open_rate,
        leverage: trade.leverage,
        reduceOnly: false,
        status: 'filled',
        filledPrice: trade.is_open ? trade.open_rate : (trade.close_rate || trade.open_rate),
        filledSize: trade.amount,
        filledAt: trade.is_open ? new Date(trade.open_date) : (trade.close_date ? new Date(trade.close_date) : undefined),
        createdAt: new Date(trade.open_date),
      });
    }

    return orders;
  }

  async getAccount(): Promise<CryptoAccountInfo> {
    this.ensureInit();

    // Get balance
    const balance = await this.get<FreqtradeBalanceResponse>('/api/v1/balance');
    const stakeCurrency = balance.stake || this.stakeCurrency;

    // Find stake currency balance
    const stakeBal = balance.currencies.find(c => c.currency === stakeCurrency);
    const free = stakeBal?.free || 0;
    const total = stakeBal?.total || 0;
    const used = stakeBal?.used || 0;

    // Calculate unrealized PnL from open positions
    const positions = await this.getPositions();
    const unrealizedPnL = positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);

    // Get profit statistics
    let realizedPnL = 0;
    try {
      const profit = await this.get<{ profit_closed_coin: number }>('/api/v1/profit');
      realizedPnL = profit.profit_closed_coin;
    } catch {
      // Profit endpoint might not be available
    }

    return {
      balance: free,
      totalMargin: used,
      unrealizedPnL,
      equity: total + unrealizedPnL,
      realizedPnL,
      totalPnL: realizedPnL + unrealizedPnL,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    this.ensureInit();

    try {
      // Freqtrade uses DELETE /api/v1/trade/{trade_id}
      await this.delete(`/api/v1/trade/${orderId}`);
      return true;
    } catch {
      return false;
    }
  }

  async adjustLeverage(
    symbol: string,
    newLeverage: number,
  ): Promise<{ success: boolean; error?: string }> {
    this.ensureInit();

    // Freqtrade doesn't support dynamic leverage adjustment via API
    // Leverage is set in the strategy configuration
    return {
      success: false,
      error: 'Freqtrade leverage is configured in strategy, not adjustable via API',
    };
  }

  // ==================== Additional Freqtrade-specific methods ====================

  /**
   * Get Freqtrade bot configuration (strategy, stake currency, trading mode, etc.)
   */
  async fetchShowConfig(): Promise<FreqtradeShowConfigResponse> {
    return this.get<FreqtradeShowConfigResponse>('/api/v1/show_config');
  }

  /**
   * Get Freqtrade whitelist (trading pair whitelist)
   */
  async fetchWhitelist(): Promise<string[]> {
    try {
      const response = await this.get<FreqtradeWhitelistResponse>('/api/v1/whitelist');
      return response.whitelist || [];
    } catch {
      // Fallback: try to extract from open trades if whitelist endpoint fails
      console.warn('freqtrade: failed to fetch whitelist, using empty list');
      return [];
    }
  }

  /**
   * Force Freqtrade to enter a pair (for use with external signal providers)
   */
  async forceEnter(pair: string, side: 'long' | 'short' = 'long'): Promise<CryptoOrderResult> {
    this.ensureInit();

    try {
      const result = await this.post<FreqtradeOrderResponse>('/api/v1/forceenter', {
        pair: toFreqtradeSymbol(pair),
        side,
      });

      return {
        success: true,
        orderId: result.order_id,
        message: `Force enter ${pair} ${side}`,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Force Freqtrade to exit a position
   */
  async forceExit(tradeId: string): Promise<CryptoOrderResult> {
    this.ensureInit();

    try {
      const result = await this.post<FreqtradeOrderResponse>('/api/v1/forceexit', {
        tradeid: parseInt(tradeId, 10),
      });

      return {
        success: true,
        orderId: result.order_id,
        message: `Force exit trade ${tradeId}`,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ==================== HTTP Helpers ====================

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('FreqtradeTradingEngine not initialized. Call init() first.');
    }
  }

  private disableProxy(): void {
    originalNoProxy = process.env.NO_PROXY;
    process.env.NO_PROXY = '*';
  }

  private restoreProxy(): void {
    if (originalNoProxy !== undefined) {
      process.env.NO_PROXY = originalNoProxy;
    } else {
      delete process.env.NO_PROXY;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.config.url}${path}`;
    this.disableProxy();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Freqtrade API error ${response.status}: ${text}`);
      }

      return response.json() as Promise<T>;
    } finally {
      this.restoreProxy();
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.config.url}${path}`;
    this.disableProxy();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Freqtrade API error ${response.status}: ${text}`);
      }

      return response.json() as Promise<T>;
    } finally {
      this.restoreProxy();
    }
  }

  private async delete(path: string): Promise<void> {
    const url = `${this.config.url}${path}`;
    this.disableProxy();
    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': this.authHeader,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Freqtrade API error ${response.status}: ${text}`);
      }
    } finally {
      this.restoreProxy();
    }
  }
}
