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
import type { Operation } from './wallet/types.js';

export function createCryptoOperationDispatcher(engine: ICryptoTradingEngine) {
  return async (op: Operation): Promise<unknown> => {
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

        const result = await engine.placeOrder(req);

        // Wrap into the format expected by parseOperationResult
        return {
          success: result.success,
          error: result.error,
          order: result.success
            ? {
                id: result.orderId,
                status: result.filledPrice ? 'filled' : 'pending',
                filledPrice: result.filledPrice,
                filledQuantity: result.filledSize,
              }
            : undefined,
        };
      }

      case 'closePosition': {
        const symbol = op.params.symbol as string;
        const size = op.params.size as number | undefined;

        // Look up the current position and place a reverse order to close
        const positions = await engine.getPositions();
        const position = positions.find(p => p.symbol === symbol);

        if (!position) {
          return { success: false, error: `No open position for ${symbol}` };
        }

        const closeSide = position.side === 'long' ? 'sell' : 'buy';
        const closeSize = size ?? position.size;

        const result = await engine.placeOrder({
          symbol,
          side: closeSide,
          type: 'market',
          size: closeSize,
          reduceOnly: true,
        });

        return {
          success: result.success,
          error: result.error,
          order: result.success
            ? {
                id: result.orderId,
                status: result.filledPrice ? 'filled' : 'pending',
                filledPrice: result.filledPrice,
                filledQuantity: result.filledSize,
              }
            : undefined,
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
