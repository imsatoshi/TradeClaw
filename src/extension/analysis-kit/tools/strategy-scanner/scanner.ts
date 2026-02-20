/**
 * Strategy scan orchestrator.
 *
 * Fetches 4H OHLCV data + funding rates, runs all three strategies,
 * and returns a structured ScanResult with session awareness.
 */

import type { ScanResult, StrategySignal, FundingRateInfo } from './types.js'
import { fetchExchangeOHLCV } from '../../data/ExchangeClient.js'
import { fetchFundingRates } from '../../data/FundingRateClient.js'
import { scanRsiDivergence } from './strategies/rsi-divergence.js'
import { scanBollingerSqueeze } from './strategies/bollinger-squeeze.js'
import { scanFundingFade } from './strategies/funding-fade.js'

const TIMEFRAME = '4h'
const CANDLE_LIMIT = 60  // 10 days of 4H data

type SessionName = 'asian' | 'london' | 'ny_overlap' | 'ny' | 'late'

interface SessionInfo {
  currentHourUTC: number
  isOptimalSession: boolean
  sessionName: SessionName
  note: string
}

function getSessionInfo(): SessionInfo {
  const hourUTC = new Date().getUTCHours()

  if (hourUTC >= 0 && hourUTC < 8) {
    return {
      currentHourUTC: hourUTC,
      isOptimalSession: false,
      sessionName: 'asian',
      note: 'Asian session: low volume. Funding fade signals most relevant.',
    }
  } else if (hourUTC >= 8 && hourUTC < 12) {
    return {
      currentHourUTC: hourUTC,
      isOptimalSession: true,
      sessionName: 'london',
      note: 'London open: good for Bollinger Squeeze breakouts.',
    }
  } else if (hourUTC >= 12 && hourUTC < 16) {
    return {
      currentHourUTC: hourUTC,
      isOptimalSession: true,
      sessionName: 'ny_overlap',
      note: 'NY/London overlap: best liquidity, all strategies valid.',
    }
  } else if (hourUTC >= 16 && hourUTC < 21) {
    return {
      currentHourUTC: hourUTC,
      isOptimalSession: true,
      sessionName: 'ny',
      note: 'NY session: RSI divergence primary, trend continuation.',
    }
  } else {
    return {
      currentHourUTC: hourUTC,
      isOptimalSession: false,
      sessionName: 'late',
      note: 'Late/early session: only act on strong signals (confidence >= 80).',
    }
  }
}

/**
 * Run all three strategies across all symbols in one call.
 *
 * @param symbols - Trading pairs to scan, e.g. ["BTC/USDT", "ETH/USDT"]
 * @param fundingRates - Optional pre-fetched funding rates (fetched automatically if omitted)
 */
export async function runStrategyScan(
  symbols: string[],
  fundingRates?: Record<string, FundingRateInfo>,
): Promise<ScanResult> {
  const scannedAt = new Date().toISOString()
  const errors: string[] = []
  const allSignals: StrategySignal[] = []

  // Fetch OHLCV and funding rates concurrently
  const [ohlcvData, rates] = await Promise.all([
    fetchExchangeOHLCV(symbols, TIMEFRAME, CANDLE_LIMIT).catch(err => {
      errors.push(`OHLCV fetch failed: ${String(err)}`)
      return {} as Record<string, import('../../data/interfaces.js').MarketData[]>
    }),
    fundingRates !== undefined
      ? Promise.resolve(fundingRates)
      : fetchFundingRates(symbols).catch(() => ({} as Record<string, FundingRateInfo>)),
  ])

  // Run all strategies for each symbol
  for (const symbol of symbols) {
    const bars = ohlcvData[symbol]
    if (!bars || bars.length < 30) {
      errors.push(`${symbol}: insufficient data (${bars?.length ?? 0} bars)`)
      continue
    }

    try {
      const rsiSignals = scanRsiDivergence(symbol, bars)
      allSignals.push(...rsiSignals)
    } catch (err) {
      errors.push(`${symbol} RSI divergence error: ${String(err)}`)
    }

    try {
      const bsSignals = scanBollingerSqueeze(symbol, bars)
      allSignals.push(...bsSignals)
    } catch (err) {
      errors.push(`${symbol} Bollinger squeeze error: ${String(err)}`)
    }

    const funding = rates[symbol]
    if (funding) {
      try {
        const ffSignals = scanFundingFade(symbol, bars, funding)
        allSignals.push(...ffSignals)
      } catch (err) {
        errors.push(`${symbol} funding fade error: ${String(err)}`)
      }
    }
  }

  // Sort by confidence descending
  allSignals.sort((a, b) => b.confidence - a.confidence)

  return {
    scannedAt,
    symbols,
    timeframe: TIMEFRAME,
    signals: allSignals,
    errors,
    sessionInfo: getSessionInfo(),
  }
}
