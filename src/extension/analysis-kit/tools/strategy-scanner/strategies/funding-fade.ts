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
import { getStrategyParams } from '../config.js'

export async function scanFundingFade(
  symbol: string,
  bars: MarketData[],
  fundingRate: FundingRateInfo,
): Promise<StrategySignal[]> {
  const config = await getStrategyParams()
  const p = config.funding_fade ?? {}

  const RSI_PERIOD = p.rsiPeriod ?? 14
  const ATR_PERIOD = p.atrPeriod ?? 14
  const FUNDING_HIGH = p.fundingHigh ?? 0.001
  const FUNDING_VERY_HIGH = p.fundingVeryHigh ?? 0.002
  const FUNDING_LOW = p.fundingLow ?? -0.0005
  const FUNDING_VERY_LOW = p.fundingVeryLow ?? -0.001
  const OVERBOUGHT = p.overboughtThreshold ?? 70
  const OVERSOLD = p.oversoldThreshold ?? 30
  const SL_MULT = p.slMultiplier ?? 2
  const TP_MULT = p.tpMultiplier ?? 3
  const STRONG_CONF = p.strongConfidence ?? 75
  const MOD_CONF = p.moderateConfidence ?? 60

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
  if (rate > FUNDING_HIGH && rsi > OVERBOUGHT) {
    const sl = currentClose + SL_MULT * atr
    const tp = currentClose - TP_MULT * atr
    const rr = (currentClose - tp) / (sl - currentClose)

    const isVeryExtreme = rate > FUNDING_VERY_HIGH
    const strength = isVeryExtreme ? 'strong' : 'moderate'
    const confidence = isVeryExtreme ? STRONG_CONF : MOD_CONF

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
  if (rate < FUNDING_LOW && rsi < OVERSOLD) {
    const sl = currentClose - SL_MULT * atr
    const tp = currentClose + TP_MULT * atr
    const rr = (tp - currentClose) / (currentClose - sl)

    const isVeryExtreme = rate < FUNDING_VERY_LOW
    const strength = isVeryExtreme ? 'strong' : 'moderate'
    const confidence = isVeryExtreme ? STRONG_CONF : MOD_CONF

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
