/**
 * Strategy scan orchestrator — 5m unified architecture.
 *
 * All 6 strategies run on 5m candles. 1H data used for regime detection only.
 * OHLCV cache (5-min TTL) avoids redundant Binance fetches across heartbeats.
 */

import type { ScanResult, StrategySignal, FundingRateInfo } from './types.js'
import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import { fetchExchangeOHLCV } from '../../../archive-analysis/data/ExchangeClient.js'
import { fetchFundingRates } from '../../../archive-analysis/data/FundingRateClient.js'
import { scanRsiDivergence } from './strategies/rsi-divergence.js'
import { scanEmaTrend } from './strategies/ema-trend.js'
import { scanBreakoutVolume } from './strategies/breakout-volume.js'
import { scanFundingFade } from './strategies/funding-fade.js'
import { scanBBMeanRevert } from './strategies/bb-mean-revert.js'
import { scanStructureBreak } from './strategies/structure-break.js'
import { appendSignalLog } from './signal-log.js'
import { getStrategyParams } from './config.js'
import { detectMarketRegime, applyRegimeFilter } from './regime.js'
import type { MarketRegime } from './regime.js'
import { computeConfluence } from './confluence.js'
import { createLogger } from '../../../../core/logger.js'

const log = createLogger('scanner')

const TIMEFRAME_5M = '5m'
const TIMEFRAME_1H = '1h'
const CANDLE_LIMIT_5M = 300  // ~25 hours of 5m data
const CANDLE_LIMIT_1H = 60   // ~2.5 days, enough for regime EMA55

// ==================== OHLCV Cache ====================

interface CacheEntry {
  data: Record<string, MarketData[]>
  fetchedAt: number
}

const ohlcvCache = new Map<string, CacheEntry>()
let CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes default for 5m data

function makeCacheKey(symbols: string[], timeframe: string, limit: number): string {
  return `${[...symbols].sort().join(',')}|${timeframe}|${limit}`
}

async function fetchWithCache(
  symbols: string[],
  timeframe: string,
  limit: number,
): Promise<Record<string, MarketData[]>> {
  const key = makeCacheKey(symbols, timeframe, limit)
  const cached = ohlcvCache.get(key)

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    log.info('OHLCV cache hit', { timeframe, count: symbols.length, ageMs: Date.now() - cached.fetchedAt })
    return cached.data
  }

  const data = await fetchExchangeOHLCV(symbols, timeframe, limit)
  ohlcvCache.set(key, { data, fetchedAt: Date.now() })
  log.info('OHLCV fetched from Binance', { timeframe, count: symbols.length })
  return data
}

// ==================== Session Info ====================

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
    return { currentHourUTC: hourUTC, isOptimalSession: false, sessionName: 'asian', note: 'Asian session: low volume. Funding fade signals most relevant.' }
  } else if (hourUTC >= 8 && hourUTC < 12) {
    return { currentHourUTC: hourUTC, isOptimalSession: true, sessionName: 'london', note: 'London open: good for breakout and trend signals.' }
  } else if (hourUTC >= 12 && hourUTC < 16) {
    return { currentHourUTC: hourUTC, isOptimalSession: true, sessionName: 'ny_overlap', note: 'NY/London overlap: best liquidity, all strategies valid.' }
  } else if (hourUTC >= 16 && hourUTC < 21) {
    return { currentHourUTC: hourUTC, isOptimalSession: true, sessionName: 'ny', note: 'NY session: RSI divergence primary, trend continuation.' }
  } else {
    return { currentHourUTC: hourUTC, isOptimalSession: false, sessionName: 'late', note: 'Late/early session: only act on strong signals (confidence >= 80).' }
  }
}

// ==================== Main Orchestrator ====================

/**
 * Run all 6 strategies on 5m data across all symbols.
 * 1H data used for regime detection only.
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

  // Load scanner config (cached, re-reads from disk at most once per minute)
  const config = await getStrategyParams()
  const scannerParams = config.scanner ?? {}

  // Apply configurable cache TTL
  const cacheTtlMinutes = scannerParams.cacheTtlMinutes ?? 5
  CACHE_TTL_MS = cacheTtlMinutes * 60 * 1000

  log.info('scan started', { symbols: symbols.length })

  // Fetch 5m (primary) + 1H (regime) sequentially to avoid Binance rate-limit bursts
  const ohlcv5m = await fetchWithCache(symbols, TIMEFRAME_5M, CANDLE_LIMIT_5M).catch((err) => {
    errors.push(`5m OHLCV fetch failed: ${String(err)}`)
    return {} as Record<string, MarketData[]>
  })
  const ohlcv1h = await fetchWithCache(symbols, TIMEFRAME_1H, CANDLE_LIMIT_1H).catch((err) => {
    log.warn('1H OHLCV fetch failed — regime detection disabled', { error: String(err) })
    return {} as Record<string, MarketData[]>
  })
  const rates = fundingRates !== undefined
    ? fundingRates
    : await fetchFundingRates(symbols).catch(() => ({} as Record<string, FundingRateInfo>))

  // Regime map for confluence scoring
  const regimeMap: Record<string, MarketRegime> = {}

  // Run all strategies per symbol on 5m data
  for (const symbol of symbols) {
    const bars5m = ohlcv5m[symbol]
    if (!bars5m || bars5m.length < 70) {
      errors.push(`${symbol}: insufficient 5m data (${bars5m?.length ?? 0} bars)`)
      continue
    }

    const symbolSignals: StrategySignal[] = []

    try {
      symbolSignals.push(...await scanRsiDivergence(symbol, bars5m))
    } catch (err) {
      errors.push(`${symbol} RSI divergence error: ${String(err)}`)
    }

    try {
      symbolSignals.push(...await scanEmaTrend(symbol, bars5m))
    } catch (err) {
      errors.push(`${symbol} EMA trend error: ${String(err)}`)
    }

    try {
      symbolSignals.push(...await scanBreakoutVolume(symbol, bars5m))
    } catch (err) {
      errors.push(`${symbol} breakout volume error: ${String(err)}`)
    }

    const funding = rates[symbol]
    if (funding) {
      try {
        symbolSignals.push(...await scanFundingFade(symbol, bars5m, funding))
      } catch (err) {
        errors.push(`${symbol} funding fade error: ${String(err)}`)
      }
    }

    try {
      symbolSignals.push(...await scanBBMeanRevert(symbol, bars5m))
    } catch (err) {
      errors.push(`${symbol} BB mean revert error: ${String(err)}`)
    }

    try {
      symbolSignals.push(...await scanStructureBreak(symbol, bars5m))
    } catch (err) {
      errors.push(`${symbol} structure break error: ${String(err)}`)
    }

    // Apply regime filter using 1H data
    if (symbolSignals.length > 0) {
      const bars1h = ohlcv1h[symbol]
      if (bars1h && bars1h.length >= 55) {
        const regimes = detectMarketRegime([symbol], { [symbol]: bars1h })
        if (regimes[0]) {
          regimeMap[symbol] = regimes[0]
          const beforeCount = symbolSignals.length
          const regimeFiltered = applyRegimeFilter(symbolSignals, regimes[0])
          symbolSignals.length = 0
          symbolSignals.push(...regimeFiltered)
          if (symbolSignals.length < beforeCount) {
            log.info('regime filter', { symbol, regime: regimes[0].regime, before: beforeCount, after: symbolSignals.length })
          }
        }
      }
    }

    allSignals.push(...symbolSignals)
  }

  // Sort by confidence descending
  allSignals.sort((a, b) => b.confidence - a.confidence)

  // Compute confluence — multi-strategy agreement
  const compositeSignals = computeConfluence(allSignals, regimeMap)

  log.info('scan complete', {
    signals: allSignals.length,
    confluence: compositeSignals.length,
    actionable: allSignals.filter((s) => s.confidence >= 70).length,
    errors: errors.length,
  })

  // Persist all signals for history tracking (fire-and-forget)
  appendSignalLog(allSignals).catch(() => { /* already logged inside */ })

  return {
    scannedAt,
    symbols,
    timeframe: '5m',
    signals: allSignals,
    compositeSignals,
    errors,
    sessionInfo: getSessionInfo(),
    ohlcv1h,
  }
}
