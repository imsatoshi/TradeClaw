/**
 * Fetch OHLCV data from Binance public futures API (no auth required).
 *
 * Used to supplement the sandbox market data provider with real-time
 * exchange data for whitelisted trading pairs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MarketData } from './interfaces.js'

/** Map common timeframe strings to Binance interval codes */
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1d': '1d', '3d': '3d', '1w': '1w', '1M': '1M',
}

// ==================== OHLCV Cache ====================

/** Resolve project root (works in both src/ and dist/) */
function resolveDataDir(): string {
  const root = process.env.PROJECT_ROOT || process.cwd()
  return join(root, 'data', 'cache', 'ohlcv')
}

function cacheKey(symbol: string, timeframe: string): string {
  return `${symbol.replace('/', '')}_${timeframe}.json`
}

function loadCache(symbol: string, timeframe: string): MarketData[] {
  const dir = resolveDataDir()
  const file = join(dir, cacheKey(symbol, timeframe))
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as MarketData[]
  } catch {
    return []
  }
}

function saveCache(symbol: string, timeframe: string, bars: MarketData[]): void {
  const dir = resolveDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, cacheKey(symbol, timeframe))
  writeFileSync(file, JSON.stringify(bars))
}

// ==================== Rate Limiting ====================

const RATE_DELAY_MS = 350  // 350ms between Binance API requests (pagination)
const BATCH_DELAY_MS = 500 // 500ms between concurrent batches (real-time fetch)

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ==================== 418 Circuit Breaker ====================

let blockedUntilMs = 0

/** Check if Binance IP is currently blocked (418 received). */
export function isBinanceBlocked(): boolean {
  return Date.now() < blockedUntilMs
}

/**
 * Mark Binance as blocked. Parses the ban expiry from the 418 response body
 * if available, otherwise uses a conservative 10-minute backoff.
 */
function markBlocked(body?: string): void {
  // Try to parse "banned until <epoch_ms>" from Binance error
  const match = body?.match(/banned until (\d{13})/)
  if (match) {
    blockedUntilMs = Number(match[1])
  } else {
    blockedUntilMs = Date.now() + 10 * 60_000 // 10 min fallback
  }
  const remaining = Math.ceil((blockedUntilMs - Date.now()) / 60_000)
  console.warn(`ExchangeClient: Binance 418 — circuit breaker open for ${remaining}m`)
}

// ==================== Historical OHLCV (with cache) ====================

/**
 * Fetch historical OHLCV data for a single symbol within a time range.
 *
 * Uses disk cache for incremental updates:
 * 1. Load cached bars from data/cache/ohlcv/
 * 2. Only fetch bars newer than cache (or all if no cache)
 * 3. Merge, deduplicate, save back to cache
 * 4. Return only the requested [startTime, endTime] slice
 *
 * Rate-limited: 200ms delay between pagination requests to avoid Binance bans.
 */
export async function fetchHistoricalOHLCV(
  symbol: string,
  timeframe: string,
  startTime: number,
  endTime: number,
): Promise<MarketData[]> {
  const interval = INTERVAL_MAP[timeframe] ?? '1h'
  const binanceSymbol = symbol.replace('/', '')
  const PAGE_LIMIT = 1500

  // Load cache and determine fetch start
  const cached = loadCache(symbol, timeframe)
  const startTimeSec = Math.floor(startTime / 1000)
  const endTimeSec = Math.floor(endTime / 1000)

  // Find the latest cached timestamp (seconds)
  let fetchFrom = startTime
  if (cached.length > 0) {
    const lastCachedSec = cached[cached.length - 1].time
    // Only fetch from after the last cached bar if cache covers our start
    if (cached[0].time <= startTimeSec) {
      fetchFrom = (lastCachedSec + 1) * 1000  // convert sec → ms, +1 to avoid overlap
    }
  }

  // Fetch new bars (if needed)
  const newBars: MarketData[] = []
  if (fetchFrom < endTime && !isBinanceBlocked()) {
    let cursor = fetchFrom
    while (cursor < endTime && !isBinanceBlocked()) {
      const url =
        `https://fapi.binance.com/fapi/v1/klines` +
        `?symbol=${binanceSymbol}&interval=${interval}` +
        `&startTime=${cursor}&endTime=${endTime}&limit=${PAGE_LIMIT}`

      const res = await fetch(url)
      if (res.status === 418) {
        const body = await res.text().catch(() => '')
        markBlocked(body)
        break
      }
      if (!res.ok) {
        console.warn(`ExchangeClient: HTTP ${res.status} for ${symbol} historical (${timeframe})`)
        break
      }

      const klines = (await res.json()) as number[][]
      if (klines.length === 0) break

      for (const k of klines) {
        newBars.push({
          symbol,
          time: Math.floor(Number(k[0]) / 1000),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        })
      }

      const lastCloseTime = Number(klines[klines.length - 1][6])
      cursor = lastCloseTime + 1

      if (klines.length < PAGE_LIMIT) break

      // Rate limit between pages
      await sleep(RATE_DELAY_MS)
    }
  }

  // Merge cached + new, deduplicate by time
  const merged = [...cached, ...newBars]
  const seen = new Set<number>()
  const deduped: MarketData[] = []
  for (const bar of merged) {
    if (!seen.has(bar.time)) {
      seen.add(bar.time)
      deduped.push(bar)
    }
  }
  deduped.sort((a, b) => a.time - b.time)

  // Save full merged cache (keep up to 120 days of data to avoid unbounded growth)
  const MAX_CACHE_SEC = 120 * 86_400
  const cutoff = Math.floor(Date.now() / 1000) - MAX_CACHE_SEC
  const toCache = deduped.filter(b => b.time >= cutoff)
  if (newBars.length > 0 || cached.length === 0) {
    saveCache(symbol, timeframe, toCache)
  }

  // Return only the requested range
  return deduped.filter(b => b.time >= startTimeSec && b.time <= endTimeSec)
}

// ==================== Real-time OHLCV (no cache) ====================

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

  // Circuit breaker: skip all fetches if Binance banned us
  if (isBinanceBlocked()) return result

  // Filter out non-Binance symbols (e.g. BTC/USD from Alpaca) — Binance Futures uses /USDT
  const binanceSymbols = symbols.filter(s => s.endsWith('/USDT'))

  // Fetch in small batches with inter-batch delays to avoid Binance rate limits
  const BATCH_SIZE = 5
  for (let i = 0; i < binanceSymbols.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_DELAY_MS)
    if (isBinanceBlocked()) break // re-check after each batch
    const batch = binanceSymbols.slice(i, i + BATCH_SIZE)
    const promises = batch.map(async (symbol) => {
      const binanceSymbol = symbol.replace('/', '')
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`

      try {
        const res = await fetch(url)
        if (res.status === 418) {
          const body = await res.text().catch(() => '')
          markBlocked(body)
          return
        }
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
