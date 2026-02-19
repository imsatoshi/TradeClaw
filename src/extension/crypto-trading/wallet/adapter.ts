import { tool } from 'ai';
import { z } from 'zod';
import type { IWallet } from './interfaces';

/**
 * Create crypto wallet AI tools (decision management)
 *
 * Git-like operations for tracking and reviewing crypto trading decisions:
 * - cryptoWalletCommit/cryptoWalletPush: Record decisions with explanations
 * - cryptoWalletLog/cryptoWalletShow/cryptoWalletStatus: Review decision history
 * - cryptoSimulatePriceChange: Dry-run impact analysis
 */
export function createCryptoWalletToolsImpl(wallet: IWallet) {
  return {
    cryptoWalletCommit: tool({
      description: `
Commit staged crypto trading operations with a message (like "git commit -m").

After staging operations with cryptoPlaceOrder/cryptoClosePosition/etc., use this to:
1. Add a commit message explaining WHY you're making these trades
2. Prepare the operations for execution

This does NOT execute the trades yet - call cryptoWalletPush after this.

Example workflow:
1. cryptoPlaceOrder({ symbol: "BTC/USD", side: "buy", ... }) → staged
2. cryptoWalletCommit({ message: "Going long BTC due to bullish RSI crossover" })
3. cryptoWalletPush() → executes and records
      `.trim(),
      inputSchema: z.object({
        message: z
          .string()
          .describe(
            'Commit message explaining your trading decision (will be recorded for future reference)',
          ),
      }),
      execute: ({ message }) => {
        return wallet.commit(message);
      },
    }),

    cryptoWalletPush: tool({
      description: `
Execute all committed crypto trading operations (like "git push").

After staging operations and committing them, use this to:
1. Execute all staged operations against the crypto trading engine
2. Record the commit with results to wallet history

Returns execution results for each operation (filled/pending/rejected).

IMPORTANT: You must call cryptoWalletCommit first before pushing.
      `.trim(),
      inputSchema: z.object({}),
      execute: async () => {
        return await wallet.push();
      },
    }),

    cryptoWalletLog: tool({
      description: `
View your crypto trading decision history (like "git log --stat").

IMPORTANT: Check this BEFORE making new trading decisions to:
- Review what you planned in recent commits
- Avoid contradicting your own strategy
- Maintain consistency across rounds
- Recall stop-loss/take-profit levels you set

Returns recent trading commits in reverse chronological order (newest first).
Each commit includes:
- hash: Unique commit identifier
- message: Your explanation for the trades (WHY you made them)
- operations: Summary of each operation (symbol, action, change, status)
  Example: { symbol: "BTC/USD", action: "placeOrder", change: "long +$1000 @95000", status: "filled" }
- timestamp: When the commit was made
- round: Which backtest round

Use symbol parameter to filter commits for a specific trading pair (like "git log -- file").
Use cryptoWalletShow(hash) for full details of a specific commit.
      `.trim(),
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Number of recent commits to return (default: 10)'),
        symbol: z
          .string()
          .optional()
          .describe('Filter commits by symbol (e.g., "BTC/USD"). Only shows commits that affected this symbol.'),
      }),
      execute: ({ limit, symbol }) => {
        return wallet.log({ limit, symbol });
      },
    }),

    cryptoWalletShow: tool({
      description: `
View details of a specific crypto wallet commit (like "git show <hash>").

Returns full commit information including:
- All operations that were executed
- Results of each operation (filled price, size, errors)
- Wallet state after the commit (positions, balance)

Use this to inspect what happened in a specific trading commit.
      `.trim(),
      inputSchema: z.object({
        hash: z.string().describe('Commit hash to inspect (8 characters)'),
      }),
      execute: ({ hash }) => {
        const commit = wallet.show(hash);
        if (!commit) {
          return { error: `Commit ${hash} not found` };
        }
        return commit;
      },
    }),

    cryptoWalletStatus: tool({
      description: `
View current crypto wallet staging area status (like "git status").

Returns:
- staged: List of operations waiting to be committed/pushed
- pendingMessage: Commit message if already committed but not pushed
- head: Hash of the latest commit
- commitCount: Total number of commits in history

Use this to check if you have pending operations before making more trades.
      `.trim(),
      inputSchema: z.object({}),
      execute: () => {
        return wallet.status();
      },
    }),

    cryptoSimulatePriceChange: tool({
      description: `
Simulate price changes to see crypto portfolio impact BEFORE making trading decisions (dry run).

Use this tool to:
- See how much you would lose if price drops to your stop-loss level
- Understand the impact of market movements on your portfolio
- Make informed decisions about position sizing and risk management

Price change syntax:
- Absolute: "@88000" means price becomes $88,000
- Relative: "+10%" means price increases by 10%, "-5%" means price decreases by 5%

You can simulate changes for:
- A specific symbol: { symbol: "BTC/USD", change: "@88000" }
- All positions: { symbol: "all", change: "-10%" }

Example usage:
1. Before setting a stop-loss at $88k: cryptoSimulatePriceChange([{ symbol: "BTC/USD", change: "@88000" }])
2. Stress test a 10% market crash: cryptoSimulatePriceChange([{ symbol: "all", change: "-10%" }])

Returns:
- currentState: Your actual portfolio state
- simulatedState: What your portfolio would look like after the price change
- summary: Total PnL change, equity change, and worst-case position

IMPORTANT: This is READ-ONLY - it does NOT modify your actual positions.
      `.trim(),
      inputSchema: z.object({
        priceChanges: z
          .array(
            z.object({
              symbol: z
                .string()
                .describe(
                  'Trading pair (e.g., "BTC/USD") or "all" for all positions',
                ),
              change: z
                .string()
                .describe(
                  'Price change: "@88000" for absolute, "+10%" or "-5%" for relative',
                ),
            }),
          )
          .describe('Array of price changes to simulate'),
      }),
      execute: async ({ priceChanges }) => {
        return await wallet.simulatePriceChange(priceChanges);
      },
    }),
  };
}
