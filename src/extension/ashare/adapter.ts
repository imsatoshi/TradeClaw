import { tool } from 'ai'
import { z } from 'zod'
import { searchStock, getQuote, getKline, detectMarket } from './client.js'
import { RealMarketDataProvider } from '../analysis-kit/data/RealMarketDataProvider.js'
import { calculateIndicator } from '../analysis-kit/tools/calculate-indicator.tool.js'
import type { MarketData } from '../analysis-kit/data/interfaces.js'

/**
 * Create A-share analysis AI tools
 *
 * Tools:
 * - searchAShare: Search stocks by code or name
 * - getAShareQuote: Batch real-time quotes
 * - getAShareKline: K-line OHLCV data
 * - calculateAShareIndicator: Technical indicator calculation
 */
export function createAShareTools() {
  return {
    searchAShare: tool({
      description:
        'Search Chinese A-share stocks by code (e.g. "600519") or name (e.g. "茅台"). Returns matching stocks with code, name, and market.',
      inputSchema: z.object({
        query: z.string().describe('Stock code or Chinese name to search'),
      }),
      execute: async ({ query }) => {
        const results = await searchStock(query)
        if (results.length === 0) {
          return { results: [], message: `No A-share stocks found for "${query}"` }
        }
        return {
          results: results.map((r) => ({
            code: r.code,
            name: r.name,
            market: r.market === 1 ? 'Shanghai' : 'Shenzhen',
          })),
        }
      },
    }),

    getAShareQuote: tool({
      description:
        'Get real-time quotes for one or more A-share stocks. Provide stock codes like ["600519", "000858"]. Returns price, open, high, low, volume, change percent.',
      inputSchema: z.object({
        symbols: z
          .array(z.string())
          .describe('Array of A-share stock codes, e.g. ["600519", "000858"]'),
      }),
      execute: async ({ symbols }) => {
        const quotes = await Promise.all(
          symbols.map(async (code) => {
            const q = await getQuote(code)
            if (!q) return { code, error: 'Quote not available' }
            return q
          }),
        )
        return { quotes }
      },
    }),

    getAShareKline: tool({
      description: `Get K-line (OHLCV) data for an A-share stock.

Returns candlestick data with date, open, close, high, low, volume, amount.

Period options: "daily" (default), "weekly", "monthly", "5min", "15min", "30min", "60min"
Count: number of bars (default 120, max 500)`,
      inputSchema: z.object({
        symbol: z.string().describe('A-share stock code, e.g. "600519"'),
        period: z
          .enum(['daily', 'weekly', 'monthly', '5min', '15min', '30min', '60min'])
          .optional()
          .describe('K-line period (default: daily)'),
        count: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Number of bars to fetch (default: 120)'),
      }),
      execute: async ({ symbol, period, count }) => {
        const bars = await getKline(symbol, undefined, period ?? 'daily', count ?? 120)
        if (bars.length === 0) {
          return { error: `No K-line data for ${symbol}` }
        }
        return { symbol, period: period ?? 'daily', count: bars.length, bars }
      },
    }),

    calculateAShareIndicator: tool({
      description: `Calculate technical indicators for A-share stocks.

Uses the same formula engine as crypto analysis. The symbol in the formula
should be the stock code (e.g. '600519').

**Examples:**
- "SMA(CLOSE('600519', 100), 20)" — 20-day moving average of 贵州茅台
- "RSI(CLOSE('600519', 50), 14)" — 14-day RSI
- "MACD(CLOSE('000858', 100), 12, 26, 9)" — MACD of 五粮液
- "BBANDS(CLOSE('300750', 100), 20, 2)" — Bollinger Bands of 宁德时代
- "EMA(CLOSE('600519', 60), 12)" — 12-day EMA

**Available functions:** CLOSE, HIGH, LOW, OPEN, VOLUME, SMA, EMA, RSI, MACD, BBANDS, ATR, STDEV, MAX, MIN, SUM, AVERAGE`,
      inputSchema: z.object({
        formula: z
          .string()
          .describe(
            'Indicator formula, e.g. "RSI(CLOSE(\'600519\', 50), 14)"',
          ),
      }),
      execute: async ({ formula }) => {
        // Extract all stock codes referenced in the formula
        const codeMatches = formula.match(/(?:CLOSE|HIGH|LOW|OPEN|VOLUME)\s*\(\s*'(\d{6})'/g)
        const codes = new Set<string>()
        if (codeMatches) {
          for (const m of codeMatches) {
            const code = m.match(/'(\d{6})'/)
            if (code) codes.add(code[1])
          }
        }

        if (codes.size === 0) {
          return { error: 'No stock code found in formula. Use format: CLOSE(\'600519\', 50)' }
        }

        // Fetch K-line data for all referenced codes and build a temporary data provider
        const allData: Record<string, MarketData[]> = {}

        for (const code of codes) {
          // Fetch enough bars (500) to cover most indicator lookbacks
          const bars = await getKline(code, undefined, 'daily', 500)
          allData[code] = bars.map((bar) => ({
            symbol: code,
            time: Math.floor(new Date(bar.date).getTime() / 1000),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
          }))
        }

        const provider = new RealMarketDataProvider(allData)
        const now = new Date()

        // calculatePreviousTime for daily bars: 1 lookback = 1 day
        const calculatePreviousTime = (lookback: number): Date => {
          const t = new Date(now)
          t.setDate(t.getDate() - lookback)
          return t
        }

        const result = await calculateIndicator(
          { currentTime: now, dataProvider: provider, calculatePreviousTime },
          formula,
        )

        return { formula, result }
      },
    }),
  }
}
