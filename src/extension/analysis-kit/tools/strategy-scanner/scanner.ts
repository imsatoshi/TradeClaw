/**
 * Strategy scan orchestrator — multi-factor pipeline.
 *
 * Architecture:
 *   Stage 1: Direction (4H regime) → determines which directions to evaluate
 *   Stage 2: Setup scoring (1H) → multi-factor 0-100 composite score
 *   Stage 3: Entry trigger (1H) → precise entry with ATR-based SL/TP
 *   Stage 4: Exit management → handled by TradeManager (not in scanner)
 *
 * Retained from v1:
 * - OHLCV cache (25-min TTL)
 * - Signal history logging
 * - Strategy weights (for AI context)
 * - Session info
 */

import type { ScanResult, StrategySignal, FundingRateInfo, PipelineSignal } from './types.js'
import type { MarketData } from '../../../archive-analysis/data/interfaces.js'
import { fetchExchangeOHLCV } from '../../../archive-analysis/data/ExchangeClient.js'
import { fetchFundingRates } from '../../../archive-analysis/data/FundingRateClient.js'
import { appendSignalLog, computeStrategyWeights } from './signal-log.js'
import type { StrategyWeight } from './signal-log.js'
import { getStrategyParams } from './config.js'
import { detectMarketRegime } from './regime.js'
import type { MarketRegime } from './regime.js'
import { scoreSetup } from './setup-scorer.js'
import { checkEntryTrigger } from './entry-trigger.js'
import { atrSeries } from './helpers.js'
import { createLogger } from '../../../../core/logger.js'

const log = createLogger('scanner')

const TIMEFRAME_4H = '4h'
const TIMEFRAME_1H = '1h'
const CANDLE_LIMIT_4H = 60   // ~10 days of 4H data
const CANDLE_LIMIT_1H = 150  // ~6 days, enough for BBWP lookback (120) + SMA20

// ==================== OHLCV Cache ====================

interface CacheEntry {
  data: Record<string, MarketData[]>
  fetchedAt: number
}

const ohlcvCache = new Map<string, CacheEntry>()

// Signal dedup — prevent logging identical triggered signals within cooldown window
const signalCooldown = new Map<string, number>()  // key → timestamp of last log
const SIGNAL_COOLDOWN_MS = 2 * 60 * 60 * 1000  // 2 hours
let CACHE_TTL_MS = 20 * 60 * 1000  // 20 minutes (overridden by config)

function makeCacheKey(symbols: string[], timeframe: string, limit: number): string {
  return `${[...symbols].sort().join(',')}|${timeframe}|${limit}`
}

const FETCH_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
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

  const data = await withTimeout(fetchExchangeOHLCV(symbols, timeframe, limit), FETCH_TIMEOUT_MS, `OHLCV ${timeframe}`)
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
    return { currentHourUTC: hourUTC, isOptimalSession: false, sessionName: 'asian', note: 'Asian session: low volume. Funding-driven setups most relevant.' }
  } else if (hourUTC >= 8 && hourUTC < 12) {
    return { currentHourUTC: hourUTC, isOptimalSession: true, sessionName: 'london', note: 'London open: good for breakout and trend setups.' }
  } else if (hourUTC >= 12 && hourUTC < 16) {
    return { currentHourUTC: hourUTC, isOptimalSession: true, sessionName: 'ny_overlap', note: 'NY/London overlap: best liquidity, all setups valid.' }
  } else if (hourUTC >= 16 && hourUTC < 21) {
    return { currentHourUTC: hourUTC, isOptimalSession: true, sessionName: 'ny', note: 'NY session: momentum and structure setups primary.' }
  } else {
    return { currentHourUTC: hourUTC, isOptimalSession: false, sessionName: 'late', note: 'Late/early session: only act on Grade A setups (score >= 70).' }
  }
}

// ==================== Main Orchestrator ====================

/**
 * Run multi-factor pipeline across all symbols.
 *
 * Pipeline:
 *   1. Detect 4H regime → determines direction(s) to evaluate
 *   2. Score each (symbol, direction) on 6 dimensions → 0-100 composite
 *   3. If score qualifies, check 1H entry trigger → precise SL/TP
 *
 * @param symbols - Trading pairs to scan, e.g. ["BTC/USDT", "ETH/USDT"]
 * @param fundingRates - Optional pre-fetched funding rates
 */
export async function runStrategyScan(
  symbols: string[],
  fundingRates?: Record<string, FundingRateInfo>,
): Promise<ScanResult> {
  const scannedAt = new Date().toISOString()
  const errors: string[] = []

  // Load scanner config (cached, re-reads from disk at most once per minute)
  const config = await getStrategyParams()
  const scannerParams = config.scanner ?? {}

  // Apply configurable cache TTL
  const cacheTtlMinutes = scannerParams.cacheTtlMinutes ?? 25
  CACHE_TTL_MS = cacheTtlMinutes * 60 * 1000

  log.info('pipeline scan started', { symbols: symbols.length })

  // Fetch timeframes sequentially to avoid Binance rate-limit bursts
  const ohlcv4h = await fetchWithCache(symbols, TIMEFRAME_4H, CANDLE_LIMIT_4H).catch((err) => {
    errors.push(`4H OHLCV fetch failed: ${String(err)}`)
    return {} as Record<string, MarketData[]>
  })
  const ohlcv1h = await fetchWithCache(symbols, TIMEFRAME_1H, CANDLE_LIMIT_1H).catch((err) => {
    log.warn('1H OHLCV fetch failed — scoring disabled', { error: String(err) })
    return {} as Record<string, MarketData[]>
  })
  const rates = fundingRates !== undefined
    ? fundingRates
    : await fetchFundingRates(symbols).catch(() => ({} as Record<string, FundingRateInfo>))

  // Stage 1: Detect 4H regime for all symbols
  const regimeMap: Record<string, MarketRegime> = {}
  const regimeResults = detectMarketRegime(symbols, ohlcv4h)
  for (const r of regimeResults) {
    regimeMap[r.symbol] = r
  }

  // Dynamic thresholds: if historical win rate is low, raise the bar
  const weights = await computeStrategyWeights().catch(() => ({} as Record<string, StrategyWeight>))
  const pipelineWeight = weights['pipeline']
  let thresholdBoost = 0
  if (pipelineWeight && pipelineWeight.sampleSize >= 10) {
    if (pipelineWeight.winRate < 0.40) thresholdBoost = 15      // very poor: require much higher score
    else if (pipelineWeight.winRate < 0.45) thresholdBoost = 10  // poor: require higher score
    else if (pipelineWeight.winRate < 0.50) thresholdBoost = 5   // below breakeven: slight boost
  }

  const THRESHOLD_TREND = (scannerParams.pipelineThresholdTrend ?? 65) + thresholdBoost
  const THRESHOLD_RANGE = (scannerParams.pipelineThresholdRange ?? 75) + thresholdBoost

  if (thresholdBoost > 0) {
    log.info('dynamic threshold boost applied', { winRate: pipelineWeight!.winRate, samples: pipelineWeight!.sampleSize, boost: thresholdBoost, trendThreshold: THRESHOLD_TREND, rangeThreshold: THRESHOLD_RANGE })
  }

  // Stage 2 + 3: Score setups and check entry triggers
  const pipelineSignals: PipelineSignal[] = []

  for (const symbol of symbols) {
    const regime = regimeMap[symbol]
    if (!regime) {
      errors.push(`${symbol}: no regime data`)
      continue
    }

    const bars1h = ohlcv1h[symbol]
    if (!bars1h || bars1h.length < 40) {
      errors.push(`${symbol}: insufficient 1H data (${bars1h?.length ?? 0} bars)`)
      continue
    }

    const funding = rates[symbol]

    // Determine directions based on regime
    const directions: ('long' | 'short')[] =
      regime.regime === 'uptrend' ? ['long']
        : regime.regime === 'downtrend' ? ['short']
        : ['long', 'short']

    // Compute 1H ATR for entry trigger
    const highs = bars1h.map(b => b.high)
    const lows = bars1h.map(b => b.low)
    const closes = bars1h.map(b => b.close)
    const atrArr = atrSeries(highs, lows, closes, 14)
    const atr = atrArr.length > 0 ? atrArr[atrArr.length - 1] : 0

    for (const direction of directions) {
      try {
        const score = await scoreSetup(symbol, direction, regime, bars1h, funding)

        // Fresh regime penalty: reduce score by 10 if regime just changed (< 8 bars = 32 hours)
        if (regime.isFreshRegime) {
          score.totalScore = Math.max(0, score.totalScore - 10)
        }

        const threshold = regime.regime === 'ranging' ? THRESHOLD_RANGE : THRESHOLD_TREND

        // Stage 3: Check entry trigger if score qualifies
        if (score.totalScore >= threshold && atr > 0) {
          score.entry = checkEntryTrigger(direction, bars1h, atr)
        }

        const grade = score.totalScore >= 78 ? 'A' as const
          : score.totalScore >= threshold ? 'B' as const
          : 'C' as const

        pipelineSignals.push({
          symbol,
          direction,
          setupScore: score.totalScore,
          regime: regime.regime,
          dimensions: score.dimensions,
          entry: score.entry,
          grade,
        })
      } catch (err) {
        errors.push(`${symbol} ${direction} scoring error: ${String(err)}`)
      }
    }
  }

  // Sort by setup score descending
  pipelineSignals.sort((a, b) => b.setupScore - a.setupScore)

  // weights already computed above (dynamic threshold + AI context)

  const qualified = pipelineSignals.filter(s => s.grade !== 'C')
  const triggered = pipelineSignals.filter(s => s.entry?.triggered)

  log.info('pipeline scan complete', {
    scored: pipelineSignals.length,
    qualified: qualified.length,
    triggered: triggered.length,
    errors: errors.length,
  })

  // Persist triggered signals to signal-log — dedup to avoid logging identical signals within cooldown
  const now = Date.now()
  const newTriggers = triggered.filter(ps => {
    const key = `${ps.symbol}|${ps.direction}`
    const lastLogged = signalCooldown.get(key) ?? 0
    return now - lastLogged >= SIGNAL_COOLDOWN_MS
  })

  const loggableSignals: StrategySignal[] = newTriggers.map(ps => ({
    strategy: 'pipeline',
    symbol: ps.symbol,
    direction: ps.direction,
    strength: ps.grade === 'A' ? 'strong' as const : 'moderate' as const,
    confidence: ps.setupScore,
    timeframe: '1h',
    entry: ps.entry!.entry,
    stopLoss: ps.entry!.stopLoss,
    takeProfit: ps.entry!.takeProfits.tp1.price,
    riskRewardRatio: ps.entry!.riskReward,
    details: {
      grade: ps.grade,
      regime: ps.regime,
      trend: ps.dimensions.trend.score,
      momentum: ps.dimensions.momentum.score,
      acceleration: ps.dimensions.acceleration.score,
      structure: ps.dimensions.structure.score,
      candle: ps.dimensions.candle.score,
      volume: ps.dimensions.volume.score,
      volatility: ps.dimensions.volatility.score,
      funding: ps.dimensions.funding.score,
    },
    reason: `Pipeline ${ps.direction.toUpperCase()}: score ${ps.setupScore}/100 [${ps.grade}] — ${ps.entry!.reason}`,
  }))

  if (loggableSignals.length > 0) {
    for (const ps of newTriggers) {
      signalCooldown.set(`${ps.symbol}|${ps.direction}`, now)
    }
    appendSignalLog(loggableSignals).catch(() => { /* already logged inside */ })
  }

  return {
    scannedAt,
    symbols,
    timeframe: '4h+1h',
    signals: loggableSignals,       // backward compat: triggered signals as StrategySignal
    compositeSignals: [],           // backward compat: empty (replaced by pipelineSignals)
    errors,
    sessionInfo: getSessionInfo(),
    ohlcv4h,
    strategyWeights: weights,
    pipelineSignals,
  }
}
