/**
 * Strategy scan orchestrator.
 *
 * Enhancements over v1:
 * - OHLCV cache (25-min TTL) — avoids redundant Binance fetches across heartbeats
 * - Multi-timeframe confirmation (1H SMA20 trend) — adjusts signal confidence ±5/15
 * - Signal history logging — persists all signals to data/signals/signal-log.json
 */

import type { ScanResult, StrategySignal, FundingRateInfo } from './types.js'
import type { MarketData } from '../../data/interfaces.js'
import { fetchExchangeOHLCV } from '../../data/ExchangeClient.js'
import { fetchFundingRates } from '../../data/FundingRateClient.js'
import { scanRsiDivergence } from './strategies/rsi-divergence.js'
import { scanEmaTrend } from './strategies/ema-trend.js'
import { scanBreakoutVolume } from './strategies/breakout-volume.js'
import { scanFundingFade } from './strategies/funding-fade.js'
import { appendSignalLog } from './signal-log.js'
import { getStrategyParams } from './config.js'
import { createLogger } from '../../../../core/logger.js'

const log = createLogger('scanner')

const TIMEFRAME_4H = '4h'
const TIMEFRAME_1H = '1h'
const CANDLE_LIMIT_4H = 60   // ~10 days of 4H data
const CANDLE_LIMIT_1H = 40   // ~2 days, enough for SMA20 trend

// ==================== OHLCV Cache ====================

interface CacheEntry {
  data: Record<string, MarketData[]>
  fetchedAt: number
}

const ohlcvCache = new Map<string, CacheEntry>()
let CACHE_TTL_MS = 25 * 60 * 1000  // 25 minutes (overridden by config)

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

// ==================== Multi-timeframe Trend Filter ====================

type Trend1H = 'bullish' | 'bearish' | 'neutral'

/**
 * Determine 1H trend direction using SMA20.
 * - last close > SMA20 * 1.005 → bullish
 * - last close < SMA20 * 0.995 → bearish
 * - otherwise → neutral
 */
function get1HTrend(bars1h: MarketData[]): Trend1H {
  if (bars1h.length < 20) return 'neutral'
  const closes = bars1h.map((b) => b.close)
  const last = closes[closes.length - 1]
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20
  if (last > sma20 * 1.005) return 'bullish'
  if (last < sma20 * 0.995) return 'bearish'
  return 'neutral'
}

/**
 * Apply 1H trend to 4H signals:
 * - Aligned:    confidence +boost (max 100), details note added
 * - Conflicting: confidence +penalty, may downgrade strength to 'weak'
 * - Neutral:    no change
 */
function applyMtfFilter(
  signals: StrategySignal[],
  trend1H: Trend1H,
  scannerParams: Record<string, number>,
): StrategySignal[] {
  if (trend1H === 'neutral') return signals

  const boost = scannerParams.mtfAlignedBoost ?? 5
  const penalty = scannerParams.mtfConflictPenalty ?? -15
  const weakThreshold = scannerParams.weakThreshold ?? 55

  return signals.map((signal) => {
    const aligned =
      (signal.direction === 'long' && trend1H === 'bullish') ||
      (signal.direction === 'short' && trend1H === 'bearish')

    if (aligned) {
      return {
        ...signal,
        confidence: Math.min(100, signal.confidence + boost),
        details: { ...signal.details, mtf_1h: `aligned (${trend1H}) +${boost}` },
      }
    } else {
      const newConf = Math.max(0, signal.confidence + penalty)
      return {
        ...signal,
        confidence: newConf,
        strength: newConf < weakThreshold ? 'weak' : signal.strength,
        details: { ...signal.details, mtf_1h: `conflicts (${trend1H}) ${penalty}` },
      }
    }
  })
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

  // Load scanner config (cached, re-reads from disk at most once per minute)
  const config = await getStrategyParams()
  const scannerParams = config.scanner ?? {}

  // Apply configurable cache TTL
  const cacheTtlMinutes = scannerParams.cacheTtlMinutes ?? 25
  CACHE_TTL_MS = cacheTtlMinutes * 60 * 1000

  log.info('scan started', { symbols: symbols.length })

  // Fetch 4H, 1H, and funding rates concurrently (4H and 1H both use cache)
  const [ohlcv4h, ohlcv1h, rates] = await Promise.all([
    fetchWithCache(symbols, TIMEFRAME_4H, CANDLE_LIMIT_4H).catch((err) => {
      errors.push(`4H OHLCV fetch failed: ${String(err)}`)
      return {} as Record<string, MarketData[]>
    }),
    fetchWithCache(symbols, TIMEFRAME_1H, CANDLE_LIMIT_1H).catch((err) => {
      log.warn('1H OHLCV fetch failed — MTF filter disabled', { error: String(err) })
      return {} as Record<string, MarketData[]>
    }),
    fundingRates !== undefined
      ? Promise.resolve(fundingRates)
      : fetchFundingRates(symbols).catch(() => ({} as Record<string, FundingRateInfo>)),
  ])

  // Run strategies per symbol
  for (const symbol of symbols) {
    const bars4h = ohlcv4h[symbol]
    if (!bars4h || bars4h.length < 30) {
      errors.push(`${symbol}: insufficient 4H data (${bars4h?.length ?? 0} bars)`)
      continue
    }

    const symbolSignals: StrategySignal[] = []

    try {
      symbolSignals.push(...await scanRsiDivergence(symbol, bars4h))
    } catch (err) {
      errors.push(`${symbol} RSI divergence error: ${String(err)}`)
    }

    try {
      symbolSignals.push(...await scanEmaTrend(symbol, bars4h))
    } catch (err) {
      errors.push(`${symbol} EMA trend error: ${String(err)}`)
    }

    try {
      symbolSignals.push(...await scanBreakoutVolume(symbol, bars4h))
    } catch (err) {
      errors.push(`${symbol} breakout volume error: ${String(err)}`)
    }

    const funding = rates[symbol]
    if (funding) {
      try {
        symbolSignals.push(...await scanFundingFade(symbol, bars4h, funding))
      } catch (err) {
        errors.push(`${symbol} funding fade error: ${String(err)}`)
      }
    }

    // Apply 1H MTF filter to this symbol's signals
    if (symbolSignals.length > 0) {
      const bars1h = ohlcv1h[symbol]
      if (bars1h && bars1h.length >= 20) {
        const trend1H = get1HTrend(bars1h)
        allSignals.push(...applyMtfFilter(symbolSignals, trend1H, scannerParams))
      } else {
        allSignals.push(...symbolSignals)
      }
    }
  }

  // Sort by confidence descending
  allSignals.sort((a, b) => b.confidence - a.confidence)

  log.info('scan complete', {
    signals: allSignals.length,
    actionable: allSignals.filter((s) => s.confidence >= 70).length,
    errors: errors.length,
  })

  // Persist all signals for history tracking (fire-and-forget)
  appendSignalLog(allSignals).catch(() => { /* already logged inside */ })

  return {
    scannedAt,
    symbols,
    timeframe: TIMEFRAME_4H,
    signals: allSignals,
    errors,
    sessionInfo: getSessionInfo(),
  }
}
