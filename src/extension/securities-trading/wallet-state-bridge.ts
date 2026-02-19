/**
 * Securities Wallet State Bridge
 *
 * Provider-agnostic: ISecuritiesTradingEngine -> WalletState assembly
 */

import type { ISecuritiesTradingEngine } from './interfaces.js';
import type { WalletState } from './wallet/types.js';

export function createSecWalletStateBridge(engine: ISecuritiesTradingEngine) {
  return async (): Promise<WalletState> => {
    const [account, holdings, orders] = await Promise.all([
      engine.getAccount(),
      engine.getPortfolio(),
      engine.getOrders(),
    ]);

    return {
      cash: account.cash,
      equity: account.equity,
      portfolioValue: account.portfolioValue,
      unrealizedPnL: account.unrealizedPnL,
      realizedPnL: account.realizedPnL,
      holdings,
      pendingOrders: orders.filter(o => o.status === 'pending'),
    };
  };
}
