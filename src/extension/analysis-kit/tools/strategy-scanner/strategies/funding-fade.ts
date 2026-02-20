/**
 * Funding Rate Fade (contrarian) strategy
 *
 * Contrarian strategy — trade against extreme funding rates confirmed by RSI:
 * - High positive funding (> 0.10%/8h) + RSI > 70 → short signal
 * - Very negative funding (< -0.05%) + RSI < 30 → long signal
 */

import type { MarketData } from '../../../data/interfaces.js'
import type { FundingRateInfo, StrategySignal } from '../types.js'
import { RSI, ATR } from '../../indicators/functions/technical.js'

const RSI_PERIOD = 14
const ATR_PERIOD = 14

// Extreme funding thresholds (per 8h)
const FUNDING_HIGH = 0.001     // 0.10%
const FUNDING_VERY_HIGH = 0.002 // 0.20%
const FUNDING_LOW = -0.0005    // -0.05%
const FUNDING_VERY_LOW = -0.001 // -0.10%

export function scanFundingFade(
  symbol: string,
  bars: MarketData[],
  fundingRate: FundingRateInfo,
): StrategySignal[] {
  if (bars.length < RSI_PERIOD + ATR_PERIOD + 2) return []

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)

  const rsi = RSI(closes, RSI_PERIOD)
  const atr = ATR(highs, lows, closes, ATR_PERIOD)
  const currentClose = closes[closes.length - 1]
  const rate = fundingRate.fundingRate

  const signals: StrategySignal[] = []

  // --- Short: extreme positive funding + overbought RSI ---
  if (rate > FUNDING_HIGH && rsi > 70) {
    const sl = currentClose + 2 * atr
    const tp = currentClose - 3 * atr
    const rr = (currentClose - tp) / (sl - currentClose)

    const isVeryExtreme = rate > FUNDING_VERY_HIGH
    const strength = isVeryExtreme ? 'strong' : 'moderate'
    const confidence = isVeryExtreme ? 75 : 60

    signals.push({
      strategy: 'funding_fade',
      symbol,
      direction: 'short',
      strength,
      confidence,
      timeframe: '4h',
      entry: currentClose,
      stopLoss: Math.round(sl * 100) / 100,
      takeProfit: Math.round(tp * 100) / 100,
      riskRewardRatio: Math.round(rr * 100) / 100,
      details: {
        fundingRate: rate,
        fundingRatePercent: fundingRate.fundingRatePercent,
        rsi: Math.round(rsi * 100) / 100,
        atr: Math.round(atr * 100) / 100,
        markPrice: fundingRate.markPrice,
        nextFunding: fundingRate.nextFundingTimeISO,
      },
      reason: `Funding fade SHORT: extreme positive funding ${fundingRate.fundingRatePercent}/8h with RSI ${rsi.toFixed(1)} (overbought). Crowd over-leveraged long.`,
    })
  }

  // --- Long: extreme negative funding + oversold RSI ---
  if (rate < FUNDING_LOW && rsi < 30) {
    const sl = currentClose - 2 * atr
    const tp = currentClose + 3 * atr
    const rr = (tp - currentClose) / (currentClose - sl)

    const isVeryExtreme = rate < FUNDING_VERY_LOW
    const strength = isVeryExtreme ? 'strong' : 'moderate'
    const confidence = isVeryExtreme ? 75 : 60

    signals.push({
      strategy: 'funding_fade',
      symbol,
      direction: 'long',
      strength,
      confidence,
      timeframe: '4h',
      entry: currentClose,
      stopLoss: Math.round(sl * 100) / 100,
      takeProfit: Math.round(tp * 100) / 100,
      riskRewardRatio: Math.round(rr * 100) / 100,
      details: {
        fundingRate: rate,
        fundingRatePercent: fundingRate.fundingRatePercent,
        rsi: Math.round(rsi * 100) / 100,
        atr: Math.round(atr * 100) / 100,
        markPrice: fundingRate.markPrice,
        nextFunding: fundingRate.nextFundingTimeISO,
      },
      reason: `Funding fade LONG: extreme negative funding ${fundingRate.fundingRatePercent}/8h with RSI ${rsi.toFixed(1)} (oversold). Crowd over-leveraged short.`,
    })
  }

  return signals
}
