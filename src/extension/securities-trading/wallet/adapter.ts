import { tool } from 'ai';
import { z } from 'zod';
import type { ISecWallet } from './interfaces';

/**
 * Create securities wallet AI tools (decision management)
 *
 * Git-like operations for tracking and reviewing securities trading decisions:
 * - secWalletCommit/secWalletPush: Record decisions with explanations
 * - secWalletLog/secWalletShow/secWalletStatus: Review decision history
 * - secSimulatePriceChange: Dry-run impact analysis
 */
export function createSecWalletToolsImpl(wallet: ISecWallet) {
  return {
    secWalletCommit: tool({
      description: `
Commit staged securities trading operations with a message (like "git commit -m").

After staging operations with secPlaceOrder/secClosePosition/etc., use this to:
1. Add a commit message explaining WHY you're making these trades
2. Prepare the operations for execution

This does NOT execute the trades yet - call secWalletPush after this.

Example workflow:
1. secPlaceOrder({ symbol: "AAPL", side: "buy", ... }) → staged
2. secWalletCommit({ message: "Buying AAPL on strong earnings beat" })
3. secWalletPush() → executes and records
      `.trim(),
      inputSchema: z.object({
        message: z
          .string()
          .describe('Commit message explaining your trading decision'),
      }),
      execute: ({ message }) => {
        return wallet.commit(message);
      },
    }),

    secWalletPush: tool({
      description: `
Execute all committed securities trading operations (like "git push").

After staging operations and committing them, use this to:
1. Execute all staged operations against the securities broker
2. Record the commit with results to wallet history

Returns execution results for each operation (filled/pending/rejected).

IMPORTANT: You must call secWalletCommit first before pushing.
      `.trim(),
      inputSchema: z.object({}),
      execute: async () => {
        return await wallet.push();
      },
    }),

    secWalletLog: tool({
      description: `
View your securities trading decision history (like "git log --stat").

IMPORTANT: Check this BEFORE making new trading decisions to:
- Review what you planned in recent commits
- Avoid contradicting your own strategy
- Maintain consistency across rounds

Returns recent trading commits in reverse chronological order (newest first).
Each commit includes:
- hash: Unique commit identifier
- message: Your explanation for the trades
- operations: Summary of each operation (symbol, action, change, status)
- timestamp: When the commit was made

Use symbol parameter to filter commits for a specific ticker.
Use secWalletShow(hash) for full details of a specific commit.
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
          .describe('Filter commits by symbol (e.g., "AAPL"). Only shows commits that affected this symbol.'),
      }),
      execute: ({ limit, symbol }) => {
        return wallet.log({ limit, symbol });
      },
    }),

    secWalletShow: tool({
      description: `
View details of a specific securities wallet commit (like "git show <hash>").

Returns full commit information including:
- All operations that were executed
- Results of each operation (filled price, qty, errors)
- Wallet state after the commit (holdings, cash)

Use this to inspect what happened in a specific trading commit.
      `.trim(),
      inputSchema: z.object({
        hash: z.string().describe('Commit hash to inspect (8 characters)'),
      }),
      execute: ({ hash }) => {
        const commit = wallet.show(hash);
        if (!commit) return { error: `Commit ${hash} not found` };
        return commit;
      },
    }),

    secWalletStatus: tool({
      description: `
View current securities wallet staging area status (like "git status").

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

    secSimulatePriceChange: tool({
      description: `
Simulate price changes to see securities portfolio impact BEFORE making decisions (dry run).

Use this tool to:
- See how much you would lose if a stock drops
- Understand the impact of market movements on your portfolio
- Make informed decisions about position sizing

Price change syntax:
- Absolute: "@150" means price becomes $150
- Relative: "+10%" means price increases by 10%, "-5%" means price decreases by 5%

You can simulate changes for:
- A specific symbol: { symbol: "AAPL", change: "@150" }
- All holdings: { symbol: "all", change: "-10%" }

IMPORTANT: This is READ-ONLY - it does NOT modify your actual holdings.
      `.trim(),
      inputSchema: z.object({
        priceChanges: z
          .array(
            z.object({
              symbol: z.string().describe('Ticker (e.g., "AAPL") or "all" for all holdings'),
              change: z.string().describe('Price change: "@150" for absolute, "+10%" or "-5%" for relative'),
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
