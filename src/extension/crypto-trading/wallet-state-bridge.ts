/**
 * Crypto Wallet State Bridge
 *
 * Provider-agnostic: ICryptoTradingEngine -> WalletState assembly
 * Used as the WalletConfig.getWalletState callback
 */

import type { ICryptoTradingEngine } from './interfaces.js';
import type { WalletState } from './wallet/types.js';

export function createCryptoWalletStateBridge(engine: ICryptoTradingEngine) {
  return async (): Promise<WalletState> => {
    const [account, positions, orders] = await Promise.all([
      engine.getAccount(),
      engine.getPositions(),
      engine.getOrders(),
    ]);

    return {
      balance: account.balance,
      equity: account.equity,
      unrealizedPnL: account.unrealizedPnL,
      realizedPnL: account.realizedPnL,
      positions,
      pendingOrders: orders.filter(o => o.status === 'pending'),
    };
  };
}
