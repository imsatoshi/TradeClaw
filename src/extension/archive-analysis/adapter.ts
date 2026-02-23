import { tool } from 'ai';
import { z } from 'zod';
import type { IAnalysisContext } from './interfaces';
import { calculate } from '../thinking-kit/tools/calculate.tool';
import { calculateIndicator } from './tools/calculate-indicator.tool';
import { globNews, grepNews, readNews } from './tools/news.tool';
import { CRYPTO_ALLOWED_SYMBOLS, CRYPTO_DEFAULT_LEVERAGE, CRYPTO_MAX_OPEN_TRADES } from '../crypto-trading/interfaces.js';
import { runStrategyScan } from '../analysis-kit/tools/strategy-scanner/index.js';
import { runBacktest, optimizeParams, batchOptimize } from '../analysis-kit/tools/strategy-scanner/index.js';
import { fetchFundingRates } from './data/FundingRateClient.js';
import { readSignalLog, computeSignalStats, syncOutcomesFromTrades } from '../analysis-kit/tools/strategy-scanner/signal-log.js';
import { appendFundingRateLog, readFundingRateHistory, computeFundingRateStats } from './data/funding-rate-log.js';
import { getRelevantPatterns, updatePattern, addLesson } from '../brain/TradeMemory.js';
import { renderChart } from '../analysis-kit/tools/chart-renderer/index.js';
import { fetchExchangeOHLCV } from './data/ExchangeClient.js';
import { storePendingProposal, generateProposalId } from '../../core/pending-actions.js';
import { sendTelegramMessage } from '../../connectors/telegram/telegram-api.js';

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
export function createAnalysisToolsImpl(sandbox: IAnalysisContext) {
  return {
    // ==================== Market data ====================

    getLatestOHLCV: tool({
      description:
        'Get the latest OHLCV (Open, High, Low, Close, Volume) candlestick data for multiple trading pairs at current time. Has data for ALL whitelisted pairs (e.g. ZEC/USDT, BTC/USDT, etc.). Use this to batch-fetch market data for all symbols you need in one call.',
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
      description: 'Get available trading symbols/pairs (from exchange whitelist)',
      inputSchema: z.object({}),
      execute: async () => {
        return [...CRYPTO_ALLOWED_SYMBOLS];
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

IMPORTANT: This tool has OHLCV data for ALL whitelisted trading pairs (fetched from exchange).
You MUST use this tool whenever the user asks about technical indicators, RSI, MACD, moving averages, etc.
Do NOT say you lack data — call this tool with the correct symbol (e.g. 'ZEC/USDT').

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
- Example: CLOSE('ZEC/USDT', 1)[0] gets the latest close price

**Examples:**
- "SMA(CLOSE('ZEC/USDT', 100), 20)" - 20-period moving average of ZEC
- "RSI(CLOSE('BTC/USDT', 50), 14)" - 14-period RSI of BTC
- "BBANDS(CLOSE('ETH/USDT', 100), 20, 2)" - Bollinger Bands of ETH
- "MACD(CLOSE('SOL/USDT', 100), 12, 26, 9)" - MACD of SOL

**Important Notes:**
- Symbol format: use 'XXX/USDT' (e.g. 'ZEC/USDT', 'BTC/USDT')
- lookback parameter: number of K-lines to look back from current time
- Up to 500 hourly candles available per symbol
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

    // ==================== Strategy scanning ====================

    strategyScan: tool({
      description: `
Scan all whitelisted trading pairs for strategy signals and confluence opportunities.

Runs 6 strategies on 4H + 15m candlestick data from Binance:
1. RSI Divergence + Volume Exhaustion (mean-reversion)
2. EMA Trend Momentum (trend-following)
3. N-Period Breakout + Volume Confirmation (breakout)
4. Funding Rate Fade (contrarian)
5. Bollinger Band Mean Reversion (15m mean-reversion)
6. Structure Break / BOS (15m breakout)

Returns TWO tiers:
- compositeSignals: CONFLUENCE signals where 2+ strategies agree (Grade A/B/C) — ONLY propose trades on these
- signals: individual strategy signals for context only — NEVER trade on single signals alone

Call this when user asks about market opportunities or during heartbeat.
      `.trim(),
      inputSchema: z.object({
        symbols: z
          .array(z.string())
          .optional()
          .describe(
            'Symbols to scan. Defaults to all whitelisted pairs if omitted. Example: ["BTC/USDT", "ETH/USDT"]',
          ),
      }),
      execute: async ({ symbols }) => {
        const targetSymbols = symbols && symbols.length > 0
          ? symbols
          : [...CRYPTO_ALLOWED_SYMBOLS];
        const result = await runStrategyScan(targetSymbols);
        // Return confluence + actionable signals (no raw OHLCV — saves ~150K+ tokens)
        const actionable = result.signals.filter(s => s.confidence >= 60);
        return {
          scannedAt: result.scannedAt,
          symbolCount: result.symbols.length,
          timeframe: result.timeframe,
          compositeSignals: result.compositeSignals,
          confluenceCount: result.compositeSignals.length,
          signals: actionable,
          signalCount: { total: result.signals.length, actionable: actionable.length },
          errors: result.errors.length > 0 ? result.errors.slice(0, 5) : [],
          sessionInfo: result.sessionInfo,
        };
      },
    }),

    cryptoGetFundingRate: tool({
      description: `
Get current funding rates for one or more perpetual futures symbols from Binance.

Funding rate indicates market sentiment and carry cost:
- Positive rate (> 0): Longs pay shorts. Crowd is over-leveraged long.
- Negative rate (< 0): Shorts pay longs. Crowd is over-leveraged short.

Extreme thresholds:
- > 0.10%/8h: Extremely bullish sentiment, contrarian short opportunity
- < -0.05%/8h: Extremely bearish sentiment, contrarian long opportunity

Use this to check funding on held positions or to get standalone funding data.
For full strategy scanning (including funding fade), use strategyScan instead.
      `.trim(),
      inputSchema: z.object({
        symbols: z
          .array(z.string())
          .describe(
            'Symbols to query, e.g. ["BTC/USDT", "ETH/USDT"]. Use USDT pairs for Binance futures.',
          ),
      }),
      execute: async ({ symbols }) => {
        const rates = await fetchFundingRates(symbols);
        appendFundingRateLog(rates).catch(() => {}); // fire-and-forget
        return rates;
      },
    }),

    // ==================== Funding rate history ====================

    getFundingRateHistory: tool({
      description: `
View historical funding rate snapshots saved from previous cryptoGetFundingRate calls.

Use this to:
- Review funding rate trends for a symbol over time
- Compute stats: average rate (24h/7d), extreme event counts, cumulative carry cost
- Decide whether funding is systematically working for or against a position

Data is auto-saved each time cryptoGetFundingRate is called.
      `.trim(),
      inputSchema: z.object({
        symbol: z
          .string()
          .optional()
          .describe('Filter by symbol, e.g. "BTC/USDT". Omit to see all symbols.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max entries to return (default 50)'),
        statsOnly: z
          .boolean()
          .optional()
          .describe('If true, return statistical summary instead of raw snapshots. Requires symbol.'),
      }),
      execute: async ({ symbol, limit, statsOnly }) => {
        if (statsOnly && symbol) {
          return await computeFundingRateStats(symbol);
        }
        return await readFundingRateHistory({ symbol, limit });
      },
    }),

    // ==================== Signal history ====================

    getSignalHistory: tool({
      description: `
View historical strategy signals detected by strategyScan, with win/loss outcomes.

Use this to:
- Review what signals have been detected recently
- Check win-rate statistics per strategy (rsi_divergence, bollinger_squeeze, funding_fade)
- See which symbols have been generating the most signals

Outcomes are recorded when positions close (via markSignalOutcome).
      `.trim(),
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max entries to return (default 30, max 100)'),
        statsOnly: z
          .boolean()
          .optional()
          .describe('If true, return only win-rate stats per strategy instead of individual entries'),
      }),
      execute: async ({ limit = 30, statsOnly = false }) => {
        if (statsOnly) {
          return await computeSignalStats();
        }
        return await readSignalLog(Math.min(limit, 100));
      },
    }),

    syncSignalOutcomes: tool({
      description: `
Sync strategy signal outcomes with closed Freqtrade trades.

Call cryptoGetOrders first, filter trades where is_open=false and has close_date, then pass them here.
Matches signals by symbol + direction + time proximity (signal within 4h of trade open time).

For each closed trade, extract:
- symbol: pair name (e.g. "ICP/USDT")
- direction: is_short → 'short', else → 'long'
- openDate: trade open_date ISO string
- closeDate: trade close_date ISO string
- closeRate: close_rate
- profitRatio: profit_ratio (positive = profit)

Run this during heartbeat or daily P&L report to keep win/loss stats up to date.
      `.trim(),
      inputSchema: z.object({
        closedTrades: z.array(z.object({
          symbol: z.string(),
          direction: z.enum(['long', 'short']),
          openDate: z.string(),
          closeDate: z.string(),
          closeRate: z.number(),
          profitRatio: z.number(),
        })),
      }),
      execute: async ({ closedTrades }) => await syncOutcomesFromTrades(closedTrades),
    }),

    // ==================== Trade Memory ====================

    tradeMemoryQuery: tool({
      description: `Query structured trade memory for patterns and lessons.
Use after reviewing a signal to check historical context — e.g. "how has rsi_divergence performed on BTC in ranging markets?"
Returns matching patterns with win rates, avg PnL, and AI-written lessons, plus recent global lessons.`,
      inputSchema: z.object({
        strategy: z.string().optional().describe('Strategy name filter, e.g. "rsi_divergence"'),
        symbol: z.string().optional().describe('Symbol filter, e.g. "BTC/USDT"'),
        regime: z.string().optional().describe('Market regime filter, e.g. "ranging"'),
      }),
      execute: async ({ strategy, symbol, regime }) => {
        return await getRelevantPatterns(strategy, symbol, regime);
      },
    }),

    tradeMemoryUpdate: tool({
      description: `Record a lesson learned from a closed trade outcome.
Call after reviewing resolved signals (via syncSignalOutcomes) to build structured trade memory.
Write a SPECIFIC, ACTIONABLE lesson — not generic advice.
Good: "SOL breakout_volume in Asian session: 3 losses in a row, avoid low-volume hours"
Bad: "需要更好的入场时机"`,
      inputSchema: z.object({
        strategy: z.string().describe('Strategy name, e.g. "rsi_divergence"'),
        symbol: z.string().describe('Trading pair, e.g. "BTC/USDT"'),
        regime: z.string().describe('Market regime at trade time, e.g. "ranging"'),
        outcome: z.enum(['win', 'loss']).describe('Trade outcome'),
        pnlPercent: z.number().describe('PnL as percentage, e.g. 2.1 or -1.3'),
        lesson: z.string().max(200).describe('1-2 sentence specific lesson learned'),
      }),
      execute: async (params) => {
        const pattern = await updatePattern(params);
        await addLesson(`[${params.strategy}|${params.symbol}|${params.regime}] ${params.lesson}`);
        return { saved: true, patternId: pattern.id, winRate: pattern.winRate, samples: pattern.samples };
      },
    }),

    // ==================== Chart Analysis (AI Vision) ====================

    analyzeChart: tool({
      description: `Generate a price chart with indicators for visual pattern analysis.
Returns a PNG chart image for Claude vision to analyze. Use when evaluating confluence signals
to spot patterns that rule-based strategies might miss (wedges, flags, H&S, volume divergences).

Only call this for symbols with active confluence signals — not every symbol on every heartbeat.`,
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair, e.g. "BTC/USDT"'),
        timeframe: z.enum(['15m', '1h', '4h']).default('15m').describe('Chart timeframe'),
        bars: z.number().default(100).describe('Number of bars to display (max 200)'),
      }),
      execute: async ({ symbol, timeframe, bars: barCount }) => {
        const safeCount = Math.min(barCount, 200)
        const ohlcv = await fetchExchangeOHLCV([symbol], timeframe, safeCount)
        const data = ohlcv[symbol]
        if (!data || data.length < 10) {
          return { error: `Insufficient data for ${symbol} ${timeframe}: ${data?.length ?? 0} bars` }
        }
        const chartBuffer = await renderChart({
          symbol,
          bars: data,
          indicators: { ema9: true, ema21: true, bb20: true, volume: true },
        })
        return {
          content: [
            {
              type: 'image' as const,
              image: chartBuffer.toString('base64'),
              mimeType: 'image/png' as const,
            },
            {
              type: 'text' as const,
              text: `${symbol} ${timeframe} chart (${data.length} bars) with EMA9 (cyan), EMA21 (red), BB20 (yellow), and volume. Analyze for: support/resistance levels, chart patterns (wedges, flags, H&S), volume divergences, and overall price structure.`,
            },
          ],
        }
      },
    }),

    // ==================== Trade proposal with confirmation buttons ====================

    proposeTradeWithButtons: tool({
      description: `
Send a trade proposal to the user via Telegram with ✅ Confirm / ❌ Cancel inline buttons.

Use this instead of directly calling cryptoPlaceOrder when you want user confirmation first.
The user clicks a button in Telegram — no need to type a reply.

When the user clicks ✅, the trade is automatically executed via another AI round.
When the user clicks ❌, the proposal is discarded.

Proposals expire after 10 minutes if not acted upon.

Best practice: call this for ALL strategy-signal-based trades.
Only call cryptoPlaceOrder directly when the user has ALREADY given explicit verbal authorization.
      `.trim(),
      inputSchema: z.object({
        summary: z
          .string()
          .describe('Human-readable proposal summary, e.g. "RSI divergence LONG ICP/USDT | Entry 8.45 | SL 8.20 | TP 9.50 | R:R 2.5x | Confidence 78%"'),
        orderInstruction: z
          .string()
          .describe('Exact instruction for the AI to execute when confirmed, e.g. "Place a market buy order for ICP/USDT with usd_size=50. Stop loss at 8.20, take profit at 9.50."'),
      }),
      execute: async ({ summary, orderInstruction }) => {
        const id = generateProposalId();
        const confirmationPrompt =
          `The user just confirmed the following trade proposal. Execute it now using MARKET order (not limit).\n\n` +
          `Proposal: ${summary}\n\n` +
          `Instruction: ${orderInstruction}\n\n` +
          `Execute the order immediately. After cryptoWalletPush, report: order ID, filled price, filled size. If rejected, report the error.`;

        storePendingProposal({ id, summary, confirmationPrompt });

        const msgText =
          `📊 Trade Proposal\n\n${summary}\n\n` +
          `Expires in 10 minutes. Tap to confirm or cancel:`;

        const messageId = await sendTelegramMessage(msgText, {
          replyMarkup: {
            inline_keyboard: [[
              { text: '✅ Confirm', callback_data: `trade:confirm:${id}` },
              { text: '❌ Cancel', callback_data: `trade:cancel:${id}` },
            ]],
          },
        });

        if (messageId === null) {
          return { proposed: false, error: 'Failed to send Telegram message — check telegram-api initialization' };
        }

        return { proposed: true, proposalId: id, message: 'Trade proposal sent to Telegram. Waiting for user confirmation.' };
      },
    }),

    // ==================== Signal backtesting ====================

    backtestSignals: tool({
      description: `Run historical backtest on strategy signals for a single symbol.
Fetches historical OHLCV from Binance, replays the strategy scanner on each 4H candle,
then simulates whether each signal would have hit TP or SL using subsequent 15m candles.

Returns per-strategy and per-regime win rates, average P&L, expectancy.
Use this to validate SL/TP parameters before trading.

Typical run: 14 days ≈ 84 scans, 30 days ≈ 180 scans. Max 90 days.
May take 10-30 seconds depending on the period.`,
      inputSchema: z.object({
        symbol: z.string().describe('Symbol, e.g. "BTC/USDT"'),
        days: z.number().int().optional().describe('Backtest period in days (default 30, max 90)'),
        strategies: z.array(z.string()).optional().describe('Filter strategies, e.g. ["ema_trend", "rsi_divergence"]'),
        confidenceMin: z.number().optional().describe('Min confidence filter (default 0)'),
      }),
      execute: async ({ symbol, days, strategies, confidenceMin }) => {
        return runBacktest({
          symbol,
          days: Math.min(days ?? 30, 90),
          strategies: strategies as import('../analysis-kit/tools/strategy-scanner/types.js').StrategyName[] | undefined,
          confidenceMin,
        })
      },
    }),

    // ==================== Parameter optimization ====================

    optimizeStrategyParams: tool({
      description: `Find optimal SL/TP multipliers for a symbol using grid-search over historical data.

Runs strategy scanning ONCE, then replays exit simulation with every combination of
slMultiplier × tpMultiplier (16 combos) to find the params that maximize expectancy.

Uses narrowed parameter ranges (SL: 0.75–2.0, TP: 1.5–3.0) and 12h max hold to
reduce overfitting risk. For production use, prefer batchOptimizeParams with WFO.

Set apply=true to automatically write the optimal params to strategy-params.json.`,
      inputSchema: z.object({
        symbol: z.string().describe('Symbol, e.g. "BTC/USDT"'),
        days: z.number().int().optional().describe('Backtest period in days (default 90)'),
        strategies: z.array(z.string()).optional().describe('Filter strategies'),
        confidenceMin: z.number().optional().describe('Min confidence filter (default 0)'),
        apply: z.boolean().optional().describe('Write best params to strategy-params.json (default false)'),
      }),
      execute: async ({ symbol, days, strategies, confidenceMin, apply }) => {
        return optimizeParams({
          symbol,
          days: days ?? 90,
          strategies: strategies as import('../analysis-kit/tools/strategy-scanner/types.js').StrategyName[] | undefined,
          confidenceMin,
          apply,
        })
      },
    }),

    batchOptimizeParams: tool({
      description: `Run SL/TP parameter optimization for ALL provided symbols with Walk-Forward Optimization (WFO).

Uses anti-overfitting framework:
1. Walk-Forward: 180d data split into 6 rolling IS/OOS folds (60d IS + 20d OOS)
2. WFO Efficiency Ratio gate: OOS_Sharpe/IS_Sharpe must be ≥ 0.5
3. Monte Carlo bootstrap: p50 expectancy must be > 0 (1000 iterations)

If either gate fails, params are NOT applied for that symbol (previous params kept).

Returns a ranked summary with gate status for each symbol.
Typical runtime: ~80 symbols ≈ 5-8 minutes (longer than plain grid search due to WFO).

IMPORTANT: After completion, report the full summary to the user, especially:
- Which symbols passed gates and have positive expectancy
- Which symbols failed gates (overfitting detected)
- Which have negative expectancy (should avoid)`,
      inputSchema: z.object({
        symbols: z.array(z.string()).describe('Symbols to optimize, e.g. from getAllowedSymbols or cryptoGetWhitelist'),
        days: z.number().int().optional().describe('Total history in days (default 90, WFO uses max(days, 180))'),
        apply: z.boolean().optional().describe('Write optimal params to strategy-params.json (default false)'),
        useWfo: z.boolean().optional().describe('Use Walk-Forward Optimization (default true). Set false for legacy grid search.'),
      }),
      execute: async ({ symbols, days, apply, useWfo }) => {
        return batchOptimize({
          symbols,
          days: days ?? 90,
          apply,
          useWfo: useWfo ?? true,
        })
      },
    }),

    // ==================== Position sizing calculator ====================

    calculatePositionSize: tool({
      description: `
Calculate optimal position size with built-in risk management checks.

Computes position size based on fixed risk percentage, then validates against
account limits before returning the result.

Returns:
- riskAmount: dollars you're willing to lose if stop is hit
- positionValue: total leveraged exposure
- stakeAmount: actual margin required (positionValue / leverage)
- size: coin quantity
- warnings: any risk limit violations detected
- approved: true if all checks pass, false if any limit exceeded

You MUST check the 'approved' field before placing the order.
If approved=false, do NOT proceed — adjust parameters or skip the trade.

Example: $500 equity, 2% risk, entry $8.50, stop $8.00
→ riskAmount=$10, stakeAmount=$56.7, size=20 coins, approved=true
      `.trim(),
      inputSchema: z.object({
        accountEquity: z.number().positive().describe('Total account equity in USDT (from cryptoGetAccount)'),
        availableBalance: z.number().positive().describe('Available balance in USDT (from cryptoGetAccount)'),
        riskPercent: z.number().positive().max(10).describe('Max risk per trade as % of equity (e.g. 2 for 2%)'),
        entryPrice: z.number().positive().describe('Planned entry price'),
        stopLossPrice: z.number().positive().describe('Stop-loss price'),
        currentOpenPositions: z.number().int().min(0).optional().describe('Number of currently open positions (from cryptoGetPositions). Used for max-trades check.'),
      }),
      execute: ({ accountEquity, availableBalance, riskPercent, entryPrice, stopLossPrice, currentOpenPositions }) => {
        const leverage = CRYPTO_DEFAULT_LEVERAGE;
        const riskAmount = accountEquity * (riskPercent / 100);
        const priceRiskPercent = Math.abs(entryPrice - stopLossPrice) / entryPrice;

        if (priceRiskPercent === 0) {
          return { error: 'entryPrice and stopLossPrice cannot be equal' };
        }

        const positionValue = riskAmount / priceRiskPercent;
        const stakeAmount = positionValue / leverage;
        const size = positionValue / entryPrice;

        // --- Risk Management Checks ---
        const warnings: string[] = [];
        let approved = true;

        // Check 1: Stake exceeds max % of equity (40%)
        const maxStakePercent = 0.40;
        const stakePercentOfEquity = stakeAmount / accountEquity;
        if (stakePercentOfEquity > maxStakePercent) {
          warnings.push(`Stake $${stakeAmount.toFixed(2)} is ${(stakePercentOfEquity * 100).toFixed(1)}% of equity (max ${maxStakePercent * 100}%)`)
          approved = false;
        }

        // Check 2: Available balance check (need 30% reserve)
        const minReserveRatio = 0.30;
        const balanceAfterTrade = availableBalance - stakeAmount;
        const reserveRatio = balanceAfterTrade / accountEquity;
        if (reserveRatio < minReserveRatio) {
          warnings.push(`After this trade, available balance would be $${balanceAfterTrade.toFixed(2)} (${(reserveRatio * 100).toFixed(1)}% of equity, min ${minReserveRatio * 100}%)`)
          approved = false;
        }

        // Check 3: Max open trades
        const maxTrades = CRYPTO_MAX_OPEN_TRADES;
        if (currentOpenPositions !== undefined && currentOpenPositions >= maxTrades) {
          warnings.push(`Already at max open trades: ${currentOpenPositions}/${maxTrades}`)
          approved = false;
        }

        // Check 4: SL distance sanity (warn if > 5% or < 0.1%)
        if (priceRiskPercent > 0.05) {
          warnings.push(`Stop-loss distance ${(priceRiskPercent * 100).toFixed(2)}% is very wide (>5%). Consider tighter SL.`)
        }
        if (priceRiskPercent < 0.001) {
          warnings.push(`Stop-loss distance ${(priceRiskPercent * 100).toFixed(3)}% is extremely tight (<0.1%). Likely to get stopped out by noise.`)
        }

        return {
          riskAmount: Math.round(riskAmount * 100) / 100,
          positionValue: Math.round(positionValue * 100) / 100,
          stakeAmount: Math.round(stakeAmount * 100) / 100,
          size: Math.round(size * 10000) / 10000,
          leverage,
          priceRiskPercent: `${(priceRiskPercent * 100).toFixed(2)}%`,
          stakePercentOfEquity: `${(stakePercentOfEquity * 100).toFixed(1)}%`,
          approved,
          warnings: warnings.length > 0 ? warnings : undefined,
          note: approved
            ? `✅ Risking ${riskPercent}% of equity ($${riskAmount.toFixed(2)}) with ${leverage}x leverage`
            : `⚠️ Trade BLOCKED: ${warnings.join('; ')}`,
        };
      },
    }),

  };
}

/** Alias for upstream compatibility. */
export const createAnalysisTools = createAnalysisToolsImpl
