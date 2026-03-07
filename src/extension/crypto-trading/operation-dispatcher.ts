/**
 * Crypto Operation Dispatcher
 *
 * Provider-agnostic bridge: Wallet Operation -> ICryptoTradingEngine method calls
 * Used as the WalletConfig.executeOperation callback
 *
 * Return values must match the structure expected by Wallet.parseOperationResult (Wallet.ts):
 * - placeOrder: { success, order?: { id, status, filledPrice, filledQuantity } }
 * - Others: { success, error? }
 */

import type { ICryptoTradingEngine, CryptoPlaceOrderRequest } from './interfaces.js';
import { CRYPTO_MAX_OPEN_TRADES, MAX_STAKE_PERCENT_OF_EQUITY, MIN_AVAILABLE_BALANCE_RATIO } from './interfaces.js';
import type { Operation } from './wallet/types.js';
import { createLogger } from '../../core/logger.js';
import { isCryptoReadOnly } from './safe-mode.js';

const log = createLogger('op-dispatcher');

export function createCryptoOperationDispatcher(
  engine: ICryptoTradingEngine,
  directExchangeEngine?: ICryptoTradingEngine,
) {
  return async (op: Operation): Promise<unknown> => {
    // === Safe mode: block all write operations when readOnly is enabled ===
    if (await isCryptoReadOnly()) {
      log.warn(`BLOCKED by readOnly mode: ${op.action} ${op.params.symbol ?? ''}`)
      return {
        success: false,
        error: `Safe mode (readOnly) is ON — ${op.action} operations are blocked. Disable readOnly in data/config/crypto.json to trade.`,
      };
    }

    switch (op.action) {
      case 'placeOrder': {
        const req: CryptoPlaceOrderRequest = {
          symbol: op.params.symbol as string,
          side: op.params.side as 'buy' | 'sell',
          type: op.params.type as 'market' | 'limit',
          size: op.params.size as number | undefined,
          usd_size: op.params.usd_size as number | undefined,
          price: op.params.price as number | undefined,
          leverage: op.params.leverage as number | undefined,
          reduceOnly: op.params.reduceOnly as boolean | undefined,
        };

        // === Risk management hard limits (cannot be bypassed by AI) ===
        if (!req.reduceOnly) {
          // 1. Max concurrent positions (from Freqtrade max_open_trades)
          const positions = await engine.getPositions();
          if (positions.length >= CRYPTO_MAX_OPEN_TRADES) {
            return {
              success: false,
              error: `Risk limit: max ${CRYPTO_MAX_OPEN_TRADES} concurrent positions reached (current: ${positions.length}). Close a position first.`,
            };
          }

          // 2. Single trade stake vs equity
          const account = await engine.getAccount();
          const stakeUsd = req.usd_size ?? (req.size && req.price ? req.size * req.price : 0);
          if (stakeUsd > 0 && account.equity > 0) {
            const riskPct = (stakeUsd / account.equity) * 100;
            if (riskPct > MAX_STAKE_PERCENT_OF_EQUITY) {
              return {
                success: false,
                error: `Risk limit: stake $${stakeUsd.toFixed(2)} is ${riskPct.toFixed(1)}% of equity ($${account.equity.toFixed(2)}), exceeds ${MAX_STAKE_PERCENT_OF_EQUITY}% limit.`,
              };
            }
          }

          // 3. Available balance floor
          const acct = account;
          if (acct.balance < acct.equity * MIN_AVAILABLE_BALANCE_RATIO) {
            return {
              success: false,
              error: `Risk limit: available balance ($${acct.balance.toFixed(2)}) below ${(MIN_AVAILABLE_BALANCE_RATIO * 100).toFixed(0)}% of equity ($${acct.equity.toFixed(2)}). No new positions.`,
            };
          }
        }

        // Stoploss orders MUST go through direct exchange engine (Freqtrade doesn't support them)
        if (req.type === 'stoploss') {
          if (!directExchangeEngine) {
            return { success: false, error: 'Stoploss orders require direct exchange connection (EXCHANGE_API_KEY/EXCHANGE_API_SECRET not configured)' };
          }
        }
        const targetEngine = (req.type === 'stoploss' && directExchangeEngine)
          ? directExchangeEngine
          : engine;
        const result = await targetEngine.placeOrder(req);

        // Wrap into the format expected by parseOperationResult
        if (!result.success) {
          return {
            success: false,
            error: result.error,
            retryHint: 'This is a TEMPORARY error. You MUST retry this operation. Do NOT give up or suggest manual alternatives.',
          };
        }

        return {
          success: true,
          order: {
            id: result.orderId,
            status: result.filledPrice ? 'filled' : 'pending',
            filledPrice: result.filledPrice,
            filledQuantity: result.filledSize,
          },
        };
      }

      case 'closePosition': {
        const symbol = op.params.symbol as string;
        const size = op.params.size as number | undefined;
        const price = op.params.price as number | undefined;
        let orderType: 'market' | 'limit' | 'stoploss' = (op.params.type as 'market' | 'limit') || (price ? 'limit' : 'market');

        // Look up the current position and place a reverse order to close
        const positions = await engine.getPositions();
        const position = positions.find(p => p.symbol === symbol);

        if (!position) {
          return { success: false, error: `No open position for ${symbol}` };
        }

        // Auto-detect stop-loss vs take-profit for limit orders.
        // A limit close at an unfavorable price (above current for short, below for long)
        // would fill immediately on the exchange — that's a stop-loss, not a take-profit.
        // Route to 'stoploss' order type so the exchange places a conditional stop order.
        if (orderType === 'limit' && price != null) {
          const currentPrice = position.markPrice;
          const isStopLoss = (position.side === 'short' && price > currentPrice)
                          || (position.side === 'long' && price < currentPrice);
          if (isStopLoss) {
            log.info(`auto-detected stoploss for ${symbol} (${position.side}, close@${price} vs current@${currentPrice})`);
            orderType = 'stoploss';
          }
        }

        const closeSide = position.side === 'long' ? 'sell' : 'buy';
        const closeSize = size ?? position.size;

        // Stoploss orders MUST go through direct exchange engine (Freqtrade doesn't support them)
        if (orderType === 'stoploss' && !directExchangeEngine) {
          return { success: false, error: 'Stoploss orders require direct exchange connection (EXCHANGE_API_KEY/EXCHANGE_API_SECRET not configured)' };
        }
        const targetEngine = (orderType === 'stoploss' && directExchangeEngine)
          ? directExchangeEngine
          : engine;

        if (orderType === 'stoploss') {
          log.info(`routing stoploss to direct exchange — ${symbol} ${closeSide} size=${closeSize} stopPrice=${price}`);
        }

        const result = await targetEngine.placeOrder({
          symbol,
          side: closeSide,
          type: orderType,
          size: closeSize,
          price,
          reduceOnly: true,
        });

        if (orderType === 'stoploss') {
          log.info(`stoploss result — success=${result.success} orderId=${result.orderId} error=${result.error} message=${result.message}`);
        }

        if (!result.success) {
          return {
            success: false,
            error: result.error,
            // No retryHint for stoploss — if it fails, don't retry (avoid AI fallback to market close)
            ...(orderType !== 'stoploss' && {
              retryHint: 'This is a TEMPORARY error. You MUST retry this operation. Do NOT give up or suggest manual alternatives.',
            }),
          };
        }

        return {
          success: true,
          order: {
            id: result.orderId,
            status: result.filledPrice ? 'filled' : 'pending',
            filledPrice: result.filledPrice,
            filledQuantity: result.filledSize,
          },
        };
      }

      case 'cancelOrder': {
        const orderId = op.params.orderId as string;
        const success = await engine.cancelOrder(orderId);
        return { success, error: success ? undefined : 'Failed to cancel order' };
      }

      case 'adjustLeverage': {
        const symbol = op.params.symbol as string;
        const newLeverage = op.params.newLeverage as number;
        return await engine.adjustLeverage(symbol, newLeverage);
      }

      default:
        throw new Error(`Unknown operation action: ${op.action}`);
    }
  };
}
