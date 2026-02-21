/**
 * Fetch OHLCV data from Binance public futures API (no auth required).
 *
 * Used to supplement the sandbox market data provider with real-time
 * exchange data for whitelisted trading pairs.
 */

import type { MarketData } from './interfaces.js'

/** Map common timeframe strings to Binance interval codes */
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1d': '1d', '3d': '3d', '1w': '1w', '1M': '1M',
}

/**
 * Fetch OHLCV K-line data from Binance Futures for multiple symbols.
 *
 * @param symbols - Standard format like ["ZEC/USDT", "BTC/USDT"]
 * @param timeframe - Candle interval, e.g. "1h", "4h", "1d"
 * @param limit - Number of candles per symbol (max 1500, default 500)
 * @returns Record mapping symbol → MarketData[]
 */
export async function fetchExchangeOHLCV(
  symbols: string[],
  timeframe: string = '1h',
  limit: number = 500,
): Promise<Record<string, MarketData[]>> {
  const interval = INTERVAL_MAP[timeframe] ?? '1h'
  const result: Record<string, MarketData[]> = {}

  // Fetch all symbols concurrently (with a concurrency cap)
  const BATCH_SIZE = 10
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE)
    const promises = batch.map(async (symbol) => {
      const binanceSymbol = symbol.replace('/', '')
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`

      try {
        const res = await fetch(url)
        if (!res.ok) {
          console.warn(`ExchangeClient: HTTP ${res.status} for ${symbol} (${timeframe})`)
          return
        }

        const klines = (await res.json()) as number[][]
        result[symbol] = klines.map((k) => ({
          symbol,
          time: Math.floor(Number(k[0]) / 1000), // ms → seconds
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }))
      } catch (err) {
        console.warn(`ExchangeClient: fetch failed for ${symbol}:`, err instanceof Error ? err.message : err)
      }
    })

    await Promise.all(promises)
  }

  return result
}
