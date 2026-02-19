import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from '../sandbox/Sandbox';
import { calculate } from '../tools/calculate.tool';
import { calculateIndicator } from '../tools/calculate-indicator.tool';
import { globNews, grepNews, readNews } from '../tools/news.tool';

/**
 * Create analysis-only AI tools from Sandbox
 *
 * These tools are shared between DotDot (backtest) and Alice V4 (live trading).
 * They do NOT include trading operations - those are injected separately.
 *
 * Includes:
 * - Market data: getLatestOHLCV, getAllowedSymbols
 * - News: globNews, grepNews, readNews
 * - Time: getCurrentTime
 * - Thinking: think, plan
 * - Calculation: calculate, calculateIndicator
 * - Utility: reportWarning, getConfirm
 *
 * NOTE: getLogs was moved to trading.adapter.ts (backtest-only, depends on historicalSnapshots)
 * NOTE: Cognition tools (getFrontalLobe, updateFrontalLobe) are in cognition.adapter.ts
 */
export function createAnalysisToolsImpl(sandbox: Sandbox) {
  return {
    // ==================== Market data ====================

    getLatestOHLCV: tool({
      description:
        'Get the latest OHLCV (Open, High, Low, Close, Volume) candlestick data for multiple trading pairs at current time. Returns K-line data with the specified interval (e.g., 1h, 4h, 1d). Use this to batch-fetch market data for all symbols you need in one call.',
      inputSchema: z.object({
        symbols: z
          .array(z.string())
          .describe(
            'Array of trading pair symbols, e.g. ["BTC/USD", "ETH/USD"]',
          ),
      }),
      execute: async ({ symbols }) => {
        return await sandbox.getLatestOHLCV(symbols);
      },
    }),

    globNews: tool({
      description: `
Search news by title pattern (like "ls" or "glob" for files).

Returns a list of matching news with index, title, content length, and metadata preview.
Use this to quickly scan headlines and find relevant news before reading full content.

Time range control:
- lookback: How far back to search, e.g. "1h", "12h", "1d", "7d" (recommended over startTime)
- Default: searches all available news up to current time

Example use cases:
- globNews({ pattern: "BTC|Bitcoin" }) - Find all Bitcoin-related news
- globNews({ pattern: "ETF", lookback: "1d" }) - Find ETF news from the last 24 hours
- globNews({ pattern: ".*", metadataFilter: { source: "official" }, limit: 10 }) - Latest 10 official news
      `.trim(),
      inputSchema: z.object({
        pattern: z
          .string()
          .describe('Regular expression to match against news titles'),
        lookback: z
          .string()
          .optional()
          .describe(
            'How far back to search: "1h", "2h", "12h", "1d", "7d", etc. Recommended over startTime.',
          ),
        metadataFilter: z
          .record(z.string(), z.string())
          .optional()
          .describe('Filter by metadata key-value pairs'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of results to return'),
      }),
      execute: async ({ pattern, lookback, metadataFilter, limit }) => {
        // Default hard limit of 500 items to prevent processing too much data
        const NEWS_LIMIT = 500;
        return await globNews(
          { getNews: () => sandbox.getNewsV2({ lookback, limit: NEWS_LIMIT }) },
          { pattern, metadataFilter, limit },
        );
      },
    }),

    grepNews: tool({
      description: `
Search news content by pattern (like "grep" for files).

Returns matching news with context around the matched text.
Use this to find specific information mentioned in news content.

Time range control:
- lookback: How far back to search, e.g. "1h", "12h", "1d", "7d" (recommended over startTime)
- Default: searches all available news up to current time

Example use cases:
- grepNews({ pattern: "interest rate", lookback: "2d" }) - Find interest rate mentions in last 2 days
- grepNews({ pattern: "\\$[0-9]+[KMB]?", contextChars: 100 }) - Find price mentions with more context
- grepNews({ pattern: "hack|exploit|vulnerability", lookback: "1d" }) - Find security news from last 24h
      `.trim(),
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            'Regular expression to search in news title and content',
          ),
        lookback: z
          .string()
          .optional()
          .describe(
            'How far back to search: "1h", "2h", "12h", "1d", "7d", etc. Recommended over startTime.',
          ),
        contextChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Number of characters to show before and after match (default: 50)',
          ),
        metadataFilter: z
          .record(z.string(), z.string())
          .optional()
          .describe('Filter by metadata key-value pairs'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of results to return'),
      }),
      execute: async ({
        pattern,
        lookback,
        contextChars,
        metadataFilter,
        limit,
      }) => {
        // Default hard limit of 500 items to prevent processing too much data
        const NEWS_LIMIT = 500;
        return await grepNews(
          { getNews: () => sandbox.getNewsV2({ lookback, limit: NEWS_LIMIT }) },
          { pattern, contextChars, metadataFilter, limit },
        );
      },
    }),

    readNews: tool({
      description: `
Read full news content by index (like "cat" for files).

Use this after globNews or grepNews to read the complete content of a specific news item.
The index is returned by globNews/grepNews results.

Note: The index is relative to the news list from your last globNews/grepNews call.
Make sure to use the same lookback parameter to get consistent indices.
      `.trim(),
      inputSchema: z.object({
        index: z
          .number()
          .int()
          .nonnegative()
          .describe('News index from globNews/grepNews results'),
        lookback: z
          .string()
          .optional()
          .describe(
            'Should match the lookback used in globNews/grepNews to get consistent indices',
          ),
      }),
      execute: async ({ index, lookback }) => {
        // Use the same limit to maintain index consistency
        const NEWS_LIMIT = 500;
        const result = await readNews(
          { getNews: () => sandbox.getNewsV2({ lookback, limit: NEWS_LIMIT }) },
          { index },
        );
        if (!result) {
          return { error: `News index ${index} not found` };
        }
        return result;
      },
    }),

    getAllowedSymbols: tool({
      description: 'Get available trading symbols/pairs',
      inputSchema: z.object({}),
      execute: async () => {
        return sandbox.getAvailableSymbols();
      },
    }),

    // ==================== Time management ====================

    getCurrentTime: tool({
      description: 'Get current time',
      inputSchema: z.object({}),
      execute: () => {
        return sandbox.getPlayheadTime();
      },
    }),

    // ==================== Thinking tools ====================

    think: tool({
      description: `
Use this to analyze current market situation and your observations.
Call this tool to:
- Summarize what you observe from market data, positions, and account
- Analyze what these observations mean
- Identify key factors influencing your decision

This is for analysis only. Use 'plan' tool separately to decide your next actions.
      `.trim(),
      inputSchema: z.object({
        observations: z
          .string()
          .describe(
            'What you currently observe from market data, positions, and account status',
          ),
        analysis: z
          .string()
          .describe(
            'Your analysis of the situation - what do these observations mean? What are the key factors?',
          ),
      }),
      execute: async () => {
        return {
          status: 'acknowledged',
          message:
            'Your analysis has been recorded. Now use the plan tool to decide your next actions.',
        };
      },
    }),

    plan: tool({
      description: `
Use this to plan your next trading actions based on your analysis.
Call this tool after using 'think' to:
- List possible actions you could take
- Decide which action to take and explain why
- Outline the specific steps you will execute

This commits you to a specific action plan before execution.
      `.trim(),
      inputSchema: z.object({
        options: z
          .array(z.string())
          .describe(
            'List of possible actions you could take (e.g., "Buy BTC", "Close ETH position", "Hold and wait")',
          ),
        decision: z
          .string()
          .describe(
            'Which option you choose and WHY - explain your reasoning for this specific choice',
          ),
        steps: z
          .array(z.string())
          .describe(
            'Specific steps you will execute (e.g., "1. placeOrder BTC buy $1000", "2. Set stop loss at $66000")',
          ),
      }),
      execute: async () => {
        return {
          status: 'acknowledged',
          message:
            'Your plan has been recorded. You may now execute the planned actions.',
        };
      },
    }),

    // ==================== Calculation tools ====================

    calculate: tool({
      description:
        'Perform mathematical calculations with precision. Use this for any arithmetic operations instead of calculating yourself. Supports basic operators: +, -, *, /, (), decimals.',
      inputSchema: z.object({
        expression: z
          .string()
          .describe(
            'Mathematical expression to evaluate, e.g. "100 / 50000", "(1000 * 0.1) / 2"',
          ),
      }),
      execute: ({ expression }) => {
        return calculate(expression);
      },
    }),

    calculateIndicator: tool({
      description: `
Calculate technical indicators and statistics using formula expressions.

**Supported Functions:**

Data Access (returns array):
- CLOSE(symbol, lookback) - Get close prices
- HIGH(symbol, lookback) - Get high prices
- LOW(symbol, lookback) - Get low prices
- OPEN(symbol, lookback) - Get open prices
- VOLUME(symbol, lookback) - Get volume data

Statistics (input: array, returns: number):
- SMA(data, period) - Simple Moving Average
- EMA(data, period) - Exponential Moving Average
- STDEV(data) - Standard Deviation
- MAX(data) - Maximum value
- MIN(data) - Minimum value
- SUM(data) - Sum of values
- AVERAGE(data) - Average value

Technical Indicators (input: array, returns: number or object):
- RSI(data, period) - Relative Strength Index
- BBANDS(data, period, stddev) - Bollinger Bands (returns {upper, middle, lower})
- MACD(data, fast, slow, signal) - MACD (returns {macd, signal, histogram})
- ATR(highs, lows, closes, period) - Average True Range

Array Access:
- Use [index] to access array elements (supports negative indices)
- Example: CLOSE('BTC/USD', 1)[0] gets the latest close price

**Examples:**
- "SMA(CLOSE('BTC/USD', 100), 20)" - 20-period moving average
- "RSI(CLOSE('BTC/USD', 50), 14)" - 14-period RSI
- "BBANDS(CLOSE('BTC/USD', 100), 20, 2)" - Bollinger Bands
- "(CLOSE('BTC/USD', 1)[0] - SMA(CLOSE('BTC/USD', 100), 50)) / SMA(CLOSE('BTC/USD', 100), 50) * 100" - Price deviation from 50MA in percentage

**Important Notes:**
- lookback parameter: number of K-lines to look back from current time
- All calculations respect time isolation (only see data <= currentTime)
- Arrays are ordered chronologically (oldest first, newest last)
- Use [0] for latest value, [-1] for oldest value in the array
      `.trim(),
      inputSchema: z.object({
        formula: z
          .string()
          .describe(
            'Formula expression using supported functions. Example: "SMA(CLOSE(\'BTC/USD\', 100), 20)"',
          ),
        description: z
          .string()
          .optional()
          .describe(
            'Optional description of what this formula calculates (for your own reference)',
          ),
      }),
      execute: async ({ formula }) => {
        return await calculateIndicator(
          {
            currentTime: sandbox.getPlayheadTime(),
            dataProvider: sandbox.marketDataProvider,
            calculatePreviousTime: (lookback) =>
              sandbox.calculatePreviousTime(lookback),
          },
          formula,
        );
      },
    }),

    // ==================== Utility tools ====================

    reportWarning: tool({
      description:
        'Report a warning when you detect anomalies or unexpected situations in the sandbox. Use this to alert about suspicious data, unexpected PnL, zero prices, or any other concerning conditions.',
      inputSchema: z.object({
        message: z.string().describe('Clear description of the warning'),
        details: z.string().describe('Additional details or context'),
      }),
      execute: async ({ message, details }) => {
        console.warn('\n⚠️  AI REPORTED WARNING:');
        console.warn(`   ${message}`);
        if (details) {
          console.warn('   Details:', details);
        }
        console.warn('');
        return { success: true, message: 'Warning logged' };
      },
    }),

    getConfirm: tool({
      description: `
Request user confirmation before executing an action.

Currently: Automatically approved.
In production environment: Will wait for user approval before proceeding.

Use this when you want to:
- Get approval for risky operations
- Ask for permission before major position changes
- Confirm strategy adjustments with the user

Example use cases:
- "I want to open a 10x leveraged position on BTC"
- "Should I close all positions due to negative market sentiment?"
- "Planning to switch from long to short strategy"
      `.trim(),
      inputSchema: z.object({
        action: z
          .string()
          .describe(
            'Clear description of the action you want to perform and why',
          ),
      }),
      execute: async ({ action }) => {
        console.log('\n🤖 AI requesting confirmation:');
        console.log(`   Action: ${action}`);
        console.log('   ✅ Auto-approved');
        console.log('');
        return {
          approved: true,
          message: 'Approved automatically',
        };
      },
    }),

  };
}
