import { tool } from 'ai';
import { z } from 'zod';
import type { ICryptoTradingEngine } from './interfaces';
import type { IWallet } from './wallet/interfaces';
import type { OrderStatusUpdate, WalletState } from './wallet/types';
import { createCryptoWalletToolsImpl } from './wallet/adapter';

/**
 * Create crypto trading AI tools (market interaction + wallet management)
 *
 * Wallet operations (git-like decision tracking):
 * - cryptoWalletCommit, cryptoWalletPush, cryptoWalletLog, cryptoWalletShow, cryptoWalletStatus, cryptoWalletSync, cryptoSimulatePriceChange
 *
 * Trading operations (staged via wallet):
 * - cryptoPlaceOrder, cryptoClosePosition, cryptoCancelOrder, cryptoAdjustLeverage
 *
 * Query operations (direct):
 * - cryptoGetPositions, cryptoGetOrders, cryptoGetAccount
 */
export function createCryptoTradingTools(
  tradingEngine: ICryptoTradingEngine,
  wallet: IWallet,
  getWalletState?: () => Promise<WalletState>,
  directExchangeEngine?: ICryptoTradingEngine,
) {
  return {
    // ==================== Wallet operations ====================
    ...createCryptoWalletToolsImpl(wallet),

    // ==================== Sync ====================

    cryptoWalletSync: tool({
      description: `
Sync pending order statuses from exchange (like "git pull").

Checks all pending orders from previous commits and fetches their latest
status from the exchange. Creates a sync commit recording any changes.

Use this after placing limit orders to check if they've been filled.
Returns the number of orders that changed status.
      `.trim(),
      inputSchema: z.object({}),
      execute: async () => {
        if (!getWalletState) {
          return { message: 'Trading engine not connected. Cannot sync.', updatedCount: 0 };
        }

        const pendingOrders = wallet.getPendingOrderIds();
        if (pendingOrders.length === 0) {
          return { message: 'No pending orders to sync.', updatedCount: 0 };
        }

        const exchangeOrders = await tradingEngine.getOrders();
        const updates: OrderStatusUpdate[] = [];

        for (const { orderId, symbol } of pendingOrders) {
          const exchangeOrder = exchangeOrders.find(o => o.id === orderId);
          if (!exchangeOrder) continue;

          const newStatus = exchangeOrder.status;
          if (newStatus !== 'pending') {
            updates.push({
              orderId,
              symbol,
              previousStatus: 'pending',
              currentStatus: newStatus,
              filledPrice: exchangeOrder.filledPrice,
              filledSize: exchangeOrder.filledSize,
            });
          }
        }

        if (updates.length === 0) {
          return {
            message: `All ${pendingOrders.length} order(s) still pending.`,
            updatedCount: 0,
          };
        }

        const state = await getWalletState();
        return await wallet.sync(updates, state);
      },
    }),

    // ==================== Trading operations (staged to Wallet) ====================

    cryptoPlaceOrder: tool({
      description: `
Stage a crypto trading order in wallet (will execute on cryptoWalletPush).

BEFORE placing orders, you SHOULD:
1. Check cryptoWalletLog({ symbol }) to review your history for THIS symbol
2. Check cryptoGetPositions to see current holdings
3. Verify this trade aligns with your stated strategy

ORDER TYPE RULES:
- Use MARKET orders by default for all trades (immediate execution, avoids stale limit orders).
- Only use LIMIT orders when the user explicitly specifies a price ("限价 0.50 买入" / "limit at 0.50").
- For market orders, do NOT set price parameter.
- For limit orders, set price to the user's specified price.

Supports two modes:
- size-based: Specify coin amount (e.g. 0.5 BTC)
- usd_size-based: Specify USD value (e.g. 1000 USDT)

For CLOSING positions, use cryptoClosePosition tool instead.

NOTE: This stages the operation. Call cryptoWalletCommit + cryptoWalletPush to execute.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair symbol, e.g. BTC/USD'),
        side: z
          .enum(['buy', 'sell'])
          .describe('Buy = open long, Sell = open short'),
        type: z
          .enum(['market', 'limit'])
          .describe(
            'Market order (immediate) or Limit order (at specific price)',
          ),
        size: z
          .number()
          .positive()
          .optional()
          .describe(
            'Order size in coins (e.g. 0.5 BTC). Mutually exclusive with usd_size.',
          ),
        usd_size: z
          .number()
          .positive()
          .optional()
          .describe(
            'Order size in USD (e.g. 1000 USDT). Will auto-calculate coin size. Mutually exclusive with size.',
          ),
        price: z
          .number()
          .positive()
          .optional()
          .describe('Price (required for limit orders)'),
        leverage: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Leverage (1-20). DO NOT set this — leverage is managed by Freqtrade strategy (currently 3x). Only use for CCXT direct engine.'),
        reduceOnly: z
          .boolean()
          .optional()
          .describe('Only reduce position (close only)'),
      }),
      execute: ({
        symbol,
        side,
        type,
        size,
        usd_size,
        price,
        leverage,
        reduceOnly,
      }) => {
        return wallet.add({
          action: 'placeOrder',
          params: { symbol, side, type, size, usd_size, price, leverage, reduceOnly },
        });
      },
    }),

    cryptoClosePosition: tool({
      description: `
Stage a crypto position close in wallet (will execute on cryptoWalletPush).

This is the preferred way to close positions instead of using cryptoPlaceOrder with reduceOnly.
Supports both market close (immediate) and limit close (take-profit / stop-loss at a specific price).

NOTE: This stages the operation. Call cryptoWalletCommit + cryptoWalletPush to execute.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair symbol, e.g. BTC/USDT'),
        size: z
          .number()
          .positive()
          .optional()
          .describe('Size to close in coins (default: close entire position)'),
        price: z
          .number()
          .positive()
          .optional()
          .describe('Limit price for take-profit or stop-loss exit. If omitted, closes at market price.'),
        type: z
          .enum(['market', 'limit'])
          .optional()
          .describe('Order type: market (immediate, default) or limit (at specific price)'),
      }),
      execute: ({ symbol, size, price, type }) => {
        return wallet.add({
          action: 'closePosition',
          params: { symbol, size, price, type: price ? (type ?? 'limit') : (type ?? 'market') },
        });
      },
    }),

    cryptoCancelOrder: tool({
      description: `
Stage an order cancellation in wallet (will execute on cryptoWalletPush).

NOTE: This stages the operation. Call cryptoWalletCommit + cryptoWalletPush to execute.
      `.trim(),
      inputSchema: z.object({
        orderId: z.string().describe('Order ID to cancel'),
      }),
      execute: ({ orderId }) => {
        return wallet.add({
          action: 'cancelOrder',
          params: { orderId },
        });
      },
    }),

    cryptoAdjustLeverage: tool({
      description: `
Stage a leverage adjustment in wallet (will execute on cryptoWalletPush).

Adjust leverage for an existing position without changing position size.
This will adjust margin requirements.

NOTE: This stages the operation. Call cryptoWalletCommit + cryptoWalletPush to execute.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair symbol, e.g. BTC/USD'),
        newLeverage: z
          .number()
          .int()
          .min(1)
          .max(20)
          .describe('New leverage (1-20)'),
      }),
      execute: ({ symbol, newLeverage }) => {
        return wallet.add({
          action: 'adjustLeverage',
          params: { symbol, newLeverage },
        });
      },
    }),

    // ==================== Query operations (no staging needed) ====================

    cryptoGetPositions: tool({
      description: `Query current open crypto positions. Can filter by symbol or get all positions.

Each position includes:
- symbol, side, size, entryPrice, leverage, markPrice, unrealizedPnL, liquidationPrice
- capitalInvested: The ACTUAL money (margin) locked in this position. Use this for account calculations.
- leveragedNotionalValue: The leveraged exposure (= size × price). This is NOT real money — do NOT add this to balance.
- percentageOfEquity: This position's capital as percentage of TOTAL account equity
- percentageOfTotal: This position's capital as percentage of total invested capital
- pnlRatioToMargin: Unrealized PnL as a percentage of capitalInvested

IMPORTANT: If result is an empty array [], it means you currently have NO open positions.
IMPORTANT: When calculating total account value, use capitalInvested (NOT leveragedNotionalValue).
  Total account value = availableBalance + sum(capitalInvested) + unrealizedPnL
RISK CHECK: Before placing new orders, verify that percentageOfEquity doesn't exceed your per-trade limit.`,
      inputSchema: z.object({
        symbol: z
          .string()
          .optional()
          .describe(
            'Trading pair symbol to filter (e.g. "BTC/USD"), or "all" for all positions (default: all)',
          ),
      }),
      execute: async ({ symbol }) => {
        const allPositions = await tradingEngine.getPositions();
        const account = await tradingEngine.getAccount();

        const totalCapitalInvested = allPositions.reduce(
          (sum, p) => sum + p.margin,
          0,
        );

        const positionsWithPercentage = allPositions.map((position) => {
          const pnlRatio =
            position.margin > 0
              ? (position.unrealizedPnL / position.margin) * 100
              : 0;
          const percentOfEquity =
            account.equity > 0
              ? (position.margin / account.equity) * 100
              : 0;
          const percentOfTotal =
            totalCapitalInvested > 0
              ? (position.margin / totalCapitalInvested) * 100
              : 0;

          return {
            symbol: position.symbol,
            side: position.side,
            size: position.size,
            entryPrice: position.entryPrice,
            leverage: position.leverage,
            markPrice: position.markPrice,
            liquidationPrice: position.liquidationPrice,
            unrealizedPnL: position.unrealizedPnL,
            capitalInvested: position.margin,
            leveragedNotionalValue: position.positionValue,
            enterTag: position.enterTag,
            dcaCount: position.dcaCount,
            profitRatio: position.profitRatio,
            percentageOfEquity: `${percentOfEquity.toFixed(1)}%`,
            percentageOfTotal: `${percentOfTotal.toFixed(1)}%`,
            pnlRatioToMargin: `${pnlRatio >= 0 ? '+' : ''}${pnlRatio.toFixed(1)}%`,
          };
        });

        const filtered = (!symbol || symbol === 'all')
          ? positionsWithPercentage
          : positionsWithPercentage.filter((p) => p.symbol === symbol);

        if (filtered.length === 0) {
          return {
            positions: [],
            message:
              'No open positions. You currently have no active crypto trades.',
          };
        }

        return {
          positions: filtered,
          totalCapitalInvested: totalCapitalInvested.toFixed(2),
          totalLeveragedNotional: allPositions.reduce((sum, p) => sum + p.positionValue, 0).toFixed(2),
          accountEquity: account.equity.toFixed(2),
        };
      },
    }),

    cryptoGetOrders: tool({
      description: 'Query crypto order history (filled, pending, cancelled)',
      inputSchema: z.object({}),
      execute: async () => {
        return await tradingEngine.getOrders();
      },
    }),

    cryptoGetOpenOrders: tool({
      description: 'Query current pending/open orders on exchange (limit orders waiting to fill). Use this to check if you have any unfilled limit orders (e.g. take-profit or stop-loss).',
      inputSchema: z.object({
        symbol: z.string().optional().describe('Trading pair symbol to filter (e.g. "BTC/USDT"), or omit for all open orders'),
      }),
      execute: async ({ symbol }) => {
        const allOrders: any[] = [];

        // Query main engine (Freqtrade)
        if ('getOpenOrders' in tradingEngine) {
          const orders = await (tradingEngine as any).getOpenOrders(symbol);
          allOrders.push(...orders);
        }

        // Query direct exchange engine (CCXT) for stop/conditional orders
        if (directExchangeEngine) {
          try {
            const directOrders = await directExchangeEngine.getOrders();
            const openDirectOrders = directOrders.filter(o =>
              o.status === 'pending' && (!symbol || o.symbol === symbol)
            );
            allOrders.push(...openDirectOrders);
          } catch {
            // Direct engine query failed, continue with main engine results only
          }
        }

        if (allOrders.length === 0) {
          return { orders: [], message: symbol ? `No open orders for ${symbol}.` : 'No open orders.' };
        }
        return allOrders;
      },
    }),

    cryptoGetAccount: tool({
      description:
        'Query crypto account info. Returns totalAccountValue (= equity, the TRUE total), availableBalance, marginUsedByPositions, unrealizedPnL, realizedPnL, totalPnL. totalAccountValue is the correct number to report as "total assets".',
      inputSchema: z.object({}),
      execute: async () => {
        const account = await tradingEngine.getAccount();
        return {
          availableBalance: account.balance,
          marginUsedByPositions: account.totalMargin,
          unrealizedPnL: account.unrealizedPnL,
          realizedPnL: account.realizedPnL,
          totalPnL: account.totalPnL,
          totalAccountValue: account.equity,
        };
      },
    }),

    // ==================== Portfolio management tools (Fund Manager) ====================

    cryptoGetWhitelist: tool({
      description: 'Query the current Freqtrade dynamic whitelist — shows which pairs the strategy is actively allowed to trade. The whitelist is generated by VolumePairList + filters (volatility, range stability, etc.) and refreshes every 30 minutes.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!('fetchWhitelist' in tradingEngine)) {
          return { error: 'Whitelist query not supported by this trading engine.' };
        }
        const whitelist = await (tradingEngine as any).fetchWhitelist();
        return {
          whitelist,
          count: whitelist.length,
        };
      },
    }),

    cryptoManageBlacklist: tool({
      description: 'Manage trading blacklist — prevent/allow the strategy from opening new trades on specific pairs. Use this to control which pairs the algorithm can trade.',
      inputSchema: z.object({
        action: z.enum(['list', 'add', 'remove']).describe('list: view current blacklist, add: block pairs, remove: unblock pairs'),
        pairs: z.array(z.string()).optional().describe('Pairs to add/remove (e.g. ["ETH/USDT", "DOGE/USDT"]). Required for add/remove.'),
      }),
      execute: async ({ action, pairs }) => {
        if (!('getBlacklist' in tradingEngine)) {
          return { error: 'Blacklist management not supported by this trading engine.' };
        }
        const engine = tradingEngine as any;
        switch (action) {
          case 'list':
            return { blacklist: await engine.getBlacklist() };
          case 'add':
            if (!pairs || pairs.length === 0) return { error: 'No pairs specified to add.' };
            return await engine.addToBlacklist(pairs);
          case 'remove':
            if (!pairs || pairs.length === 0) return { error: 'No pairs specified to remove.' };
            return await engine.removeFromBlacklist(pairs);
        }
      },
    }),

    cryptoLockPair: tool({
      description: 'Temporarily lock a trading pair — prevent the strategy from opening new positions. Locks auto-expire. Use for short-term risk events (high volatility, news events). More granular than blacklist.',
      inputSchema: z.object({
        action: z.enum(['list', 'lock', 'unlock']).describe('list: view active locks, lock: create a lock, unlock: remove a lock'),
        pair: z.string().optional().describe('Trading pair (e.g. "ETH/USDT"). Required for lock.'),
        duration: z.string().optional().describe('Lock duration, e.g. "4h", "1d". Required for lock.'),
        side: z.enum(['long', 'short', '*']).optional().describe('Side to lock. Default "*" (both sides).'),
        reason: z.string().optional().describe('Reason for locking the pair.'),
        lockId: z.number().optional().describe('Lock ID to remove. Required for unlock.'),
      }),
      execute: async ({ action, pair, duration, side, reason, lockId }) => {
        if (!('getLocks' in tradingEngine)) {
          return { error: 'Pair locking not supported by this trading engine.' };
        }
        const engine = tradingEngine as any;
        switch (action) {
          case 'list':
            return { locks: await engine.getLocks() };
          case 'lock': {
            if (!pair) return { error: 'No pair specified.' };
            if (!duration) return { error: 'No duration specified.' };
            // Convert duration string to ISO datetime
            const now = new Date();
            const match = duration.match(/^(\d+)(m|h|d)$/);
            if (!match) return { error: 'Invalid duration format. Use e.g. "30m", "4h", "1d".' };
            const value = parseInt(match[1], 10);
            const unit = match[2];
            if (unit === 'm') now.setMinutes(now.getMinutes() + value);
            else if (unit === 'h') now.setHours(now.getHours() + value);
            else if (unit === 'd') now.setDate(now.getDate() + value);
            const until = now.toISOString();
            return await engine.lockPair(pair, until, side || '*', reason || 'Locked by AI portfolio manager');
          }
          case 'unlock':
            if (!lockId) return { error: 'No lockId specified.' };
            await engine.deleteLock(lockId);
            return { success: true, message: `Lock ${lockId} removed.` };
        }
      },
    }),

    cryptoGetStrategyStats: tool({
      description: 'View historical entry/exit signal performance. Use this to evaluate which entry tags are profitable and which should be disabled via blacklist.',
      inputSchema: z.object({
        type: z.enum(['entries', 'exits', 'mix_tags']).describe('entries: stats by entry signal, exits: stats by exit reason, mix_tags: combined entry+exit stats'),
        pair: z.string().optional().describe('Filter by trading pair (e.g. "BTC/USDT"). Omit for all pairs.'),
      }),
      execute: async ({ type, pair }) => {
        if (!('getEntryStats' in tradingEngine)) {
          return { error: 'Strategy stats not supported by this trading engine.' };
        }
        const engine = tradingEngine as any;
        switch (type) {
          case 'entries':
            return await engine.getEntryStats(pair);
          case 'exits':
            return await engine.getExitStats(pair);
          case 'mix_tags':
            return await engine.getMixTagStats(pair);
        }
      },
    }),

    cryptoReloadConfig: tool({
      description: 'Reload Freqtrade configuration. Use after whitelist/blacklist changes to ensure the strategy picks up the new settings.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!('reloadConfig' in tradingEngine)) {
          return { error: 'Config reload not supported by this trading engine.' };
        }
        return await (tradingEngine as any).reloadConfig();
      },
    }),
  };
}
