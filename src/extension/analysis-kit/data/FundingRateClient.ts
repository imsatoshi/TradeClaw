/**
 * Fetch funding rate data from Binance Futures public API (no auth required).
 *
 * GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT
 */

import type { FundingRateInfo } from '../tools/strategy-scanner/types.js'
import { isBinanceBlocked } from './ExchangeClient.js'

/**
 * Fetch current funding rates for multiple symbols.
 *
 * @param symbols - Standard format like ["BTC/USDT", "ETH/USDT"]
 * @returns Record mapping symbol → FundingRateInfo (failed symbols silently skipped)
 */
export async function fetchFundingRates(
  symbols: string[],
): Promise<Record<string, FundingRateInfo>> {
  const result: Record<string, FundingRateInfo> = {}

  if (isBinanceBlocked()) return result

  // Filter to Binance Futures symbols only
  const binanceSymbols = symbols.filter(s => s.endsWith('/USDT'))

  const BATCH_SIZE = 5
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < binanceSymbols.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(500)
    if (isBinanceBlocked()) break
    const batch = binanceSymbols.slice(i, i + BATCH_SIZE)
    const promises = batch.map(async (symbol) => {
      const binanceSymbol = symbol.replace('/', '')
      const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${binanceSymbol}`

      try {
        const res = await fetch(url)
        if (!res.ok) {
          console.warn(`FundingRateClient: HTTP ${res.status} for ${symbol}`)
          return
        }

        const data = await res.json() as {
          symbol: string
          lastFundingRate: string
          markPrice: string
          indexPrice: string
          nextFundingTime: number
        }

        const rate = parseFloat(data.lastFundingRate)
        result[symbol] = {
          symbol,
          fundingRate: rate,
          fundingRatePercent: `${(rate * 100).toFixed(4)}%`,
          markPrice: parseFloat(data.markPrice),
          indexPrice: parseFloat(data.indexPrice),
          nextFundingTime: data.nextFundingTime,
          nextFundingTimeISO: new Date(data.nextFundingTime).toISOString(),
        }
      } catch (err) {
        console.warn(`FundingRateClient: fetch failed for ${symbol}:`, err instanceof Error ? err.message : err)
      }
    })

    await Promise.all(promises)
  }

  return result
}
