/**
 * Funding Rate Fade (contrarian) strategy
 *
 * Contrarian strategy — trade against extreme funding rates:
 * - High positive funding (> 0.08%/8h) → short signal
 * - Very negative funding (< -0.04%/8h) → long signal
 * - RSI is used as a bonus/upgrade factor, not a hard requirement
 */

import type { MarketData } from '../../../../archive-analysis/data/interfaces.js'
import type { FundingRateInfo, StrategySignal } from '../types.js'
import { RSI } from '../../../../archive-analysis/tools/indicators/functions/technical.js'
import { atrSeries } from '../helpers.js'
import { getStrategyParamsFor } from '../config.js'

export async function scanFundingFade(
  symbol: string,
  bars: MarketData[],
  fundingRate: FundingRateInfo,
  bars15m?: MarketData[],
): Promise<StrategySignal[]> {
  const p = await getStrategyParamsFor('funding_fade', symbol)

  const RSI_PERIOD = p.rsiPeriod ?? 14
  const ATR_PERIOD = p.atrPeriod ?? 14
  const FUNDING_HIGH = p.fundingHigh ?? 0.0008        // 0.08%/8h (relaxed from 0.10%)
  const FUNDING_VERY_HIGH = p.fundingVeryHigh ?? 0.0015 // 0.15%/8h
  const FUNDING_LOW = p.fundingLow ?? -0.0004          // -0.04%/8h (relaxed from -0.05%)
  const FUNDING_VERY_LOW = p.fundingVeryLow ?? -0.0008  // -0.08%/8h
  const OVERBOUGHT = p.overboughtThreshold ?? 70
  const OVERSOLD = p.oversoldThreshold ?? 30
  const SL_MULT = p.slMultiplier ?? 2
  const TP_MULT = p.tpMultiplier ?? 3
  const STRONG_CONF = p.strongConfidence ?? 75
  const MOD_CONF = p.moderateConfidence ?? 55

  if (bars.length < RSI_PERIOD + ATR_PERIOD + 2) return []

  const closes = bars.map(b => b.close)
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)

  const rsi = RSI(closes, RSI_PERIOD)

  // SL/TP uses 15m ATR when available (tighter, more appropriate for 15m execution)
  const slTpBars = bars15m && bars15m.length >= ATR_PERIOD + 2 ? bars15m : bars
  const slTpHighs = slTpBars.map(b => b.high)
  const slTpLows = slTpBars.map(b => b.low)
  const slTpCloses = slTpBars.map(b => b.close)
  const atrArr = atrSeries(slTpHighs, slTpLows, slTpCloses, ATR_PERIOD)
  const atr = atrArr[atrArr.length - 1]

  const currentClose = closes[closes.length - 1]
  const rate = fundingRate.fundingRate

  const signals: StrategySignal[] = []

  // --- Short: extreme positive funding (RSI no longer required, used as upgrade) ---
  if (rate > FUNDING_HIGH) {
    const sl = currentClose + SL_MULT * atr
    const tp = currentClose - TP_MULT * atr
    const rr = (currentClose - tp) / (sl - currentClose)

    const isVeryExtreme = rate > FUNDING_VERY_HIGH
    const rsiConfirms = rsi > OVERBOUGHT
    const isStrong = isVeryExtreme || rsiConfirms
    const strength = isStrong ? 'strong' : 'moderate'
    const confidence = isStrong ? STRONG_CONF : MOD_CONF

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
        rsiConfirms: rsiConfirms ? 'yes' : 'no',
        atr: Math.round(atr * 100) / 100,
        slTpTimeframe: bars15m && bars15m.length >= ATR_PERIOD + 2 ? '15m' : '4h',
        markPrice: fundingRate.markPrice,
        nextFunding: fundingRate.nextFundingTimeISO,
      },
      reason: `Funding fade SHORT: extreme positive funding ${fundingRate.fundingRatePercent}/8h${rsiConfirms ? ` + RSI ${rsi.toFixed(1)} overbought` : `, RSI ${rsi.toFixed(1)}`}. Crowd over-leveraged long.`,
    })
  }

  // --- Long: extreme negative funding (RSI no longer required, used as upgrade) ---
  if (rate < FUNDING_LOW) {
    const sl = currentClose - SL_MULT * atr
    const tp = currentClose + TP_MULT * atr
    const rr = (tp - currentClose) / (currentClose - sl)

    const isVeryExtreme = rate < FUNDING_VERY_LOW
    const rsiConfirms = rsi < OVERSOLD
    const isStrong = isVeryExtreme || rsiConfirms
    const strength = isStrong ? 'strong' : 'moderate'
    const confidence = isStrong ? STRONG_CONF : MOD_CONF

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
        rsiConfirms: rsiConfirms ? 'yes' : 'no',
        atr: Math.round(atr * 100) / 100,
        slTpTimeframe: bars15m && bars15m.length >= ATR_PERIOD + 2 ? '15m' : '4h',
        markPrice: fundingRate.markPrice,
        nextFunding: fundingRate.nextFundingTimeISO,
      },
      reason: `Funding fade LONG: extreme negative funding ${fundingRate.fundingRatePercent}/8h${rsiConfirms ? ` + RSI ${rsi.toFixed(1)} oversold` : `, RSI ${rsi.toFixed(1)}`}. Crowd over-leveraged short.`,
    })
  }

  return signals
}
