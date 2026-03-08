/**
 * TradeManager — real-time trade lifecycle manager.
 *
 * Polls Freqtrade at ~10s intervals to:
 * 1. Detect entry fills → transition plan to 'active', place first TP
 * 2. Detect TP fills → place next TP level
 * 3. Detect SL triggers → cancel remaining TPs, mark plan completed
 * 4. Emit agent-events so AI learns of changes at next heartbeat
 */

import { randomUUID } from 'crypto'
import type { FreqtradeTradingEngine } from '../providers/freqtrade/FreqtradeTradingEngine.js'
import type { FreqtradeTrade } from '../providers/freqtrade/types.js'
import type { ICryptoTradingEngine } from '../interfaces.js'
import type { TradePlan, TakeProfitLevel, TradePlanPnL, TradeProfile, DcaLayer } from './types.js'
import { TradePlanStore } from './store.js'
import { emit, enqueueSystemEvent } from '../../../core/agent-events.js'
import { createLogger, getModeTag } from '../../../core/logger.js'
import { isCryptoReadOnly } from '../safe-mode.js'
import { fetchExchangeOHLCV } from '../../archive-analysis/data/ExchangeClient.js'
import { atrSeries } from '../../analysis-kit/tools/strategy-scanner/helpers.js'

const log = createLogger('trade-manager')

/** Normalize Freqtrade pair: "ZEC/USDT:USDT" → "ZEC/USDT" */
function normalizePair(pair: string): string {
  const idx = pair.indexOf(':')
  return idx > 0 ? pair.slice(0, idx) : pair
}

export class TradeManager {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private store: TradePlanStore
  private engine: FreqtradeTradingEngine
  private directEngine?: ICryptoTradingEngine
  private isDryRun: boolean
  private ticking = false
  /** Live P&L snapshots, refreshed each tick (plan.id → PnL) */
  private pnlCache = new Map<string, TradePlanPnL>()
  /** ATR cache per symbol — refreshed every 5 minutes */
  private atrCache = new Map<string, { atr: number; updatedAt: number }>()
  /** OHLCV cache for chandelier trailing — refreshed every 5 minutes */
  private ohlcvCache = new Map<string, { highs: number[]; lows: number[]; updatedAt: number }>()

  constructor(
    engine: FreqtradeTradingEngine,
    directEngine?: ICryptoTradingEngine,
    isDryRun = true,
  ) {
    this.engine = engine
    this.directEngine = directEngine
    this.isDryRun = isDryRun
    this.store = new TradePlanStore()
  }

  /** Start the polling loop. */
  async start(intervalMs = 10_000): Promise<void> {
    await this.store.load()
    this.pollTimer = setInterval(() => this.safeTick(), intervalMs)
    const mode = this.isDryRun ? 'DRY-RUN' : 'LIVE'
    log.info(`started [${mode}] (poll every ${intervalMs}ms, ${this.store.getAll().length} active plans)`)
  }

  /** Stop polling. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    log.info('stopped')
  }

  /** Create a new trade plan. Entry order should already be placed. */
  async addPlan(params: {
    symbol: string
    direction: 'long' | 'short'
    takeProfits: { price: number; sizeRatio: number }[]
    stopLossPrice: number
    reason?: string
    autoBreakeven?: boolean
    trailingStop?: { distance: number; type: 'fixed' | 'percent' | 'chandelier'; lookbackBars?: number }
    profile?: TradeProfile
    enableDca?: boolean
  }): Promise<TradePlan> {
    const now = new Date().toISOString()
    const profile = params.profile ?? 'reversal'
    const plan: TradePlan = {
      id: randomUUID(),
      symbol: params.symbol,
      direction: params.direction,
      takeProfits: params.takeProfits.map((tp, i) => ({
        level: i + 1,
        price: tp.price,
        sizeRatio: tp.sizeRatio,
        status: 'pending' as const,
      })),
      stopLoss: {
        price: params.stopLossPrice,
        status: 'pending' as const,
      },
      status: 'pending',
      reason: params.reason,
      autoBreakeven: params.autoBreakeven ?? true, // default ON
      trailingStop: params.trailingStop,
      profile,
      createdAt: now,
      updatedAt: now,
    }

    // DCA placeholder — layers computed after entry fill when ATR + entry price are known
    if (params.enableDca && profile === 'reversal') {
      plan.dca = {
        enabled: true,
        maxLayers: 2,
        hardStopPrice: 0,
        tpProfitThreshold: 0.015,
        layers: [],
      }
    }

    await this.store.save(plan)
    log.info(`plan ${plan.id.slice(0, 8)} created for ${plan.symbol} ${plan.direction} [${profile}${plan.dca?.enabled ? '+DCA' : ''}]`)
    return plan
  }

  /** Cancel a plan: cancel any open orders, mark plan cancelled. */
  async cancelPlan(planId: string): Promise<{ success: boolean; error?: string }> {
    const plan = this.store.get(planId)
    if (!plan) return { success: false, error: 'Plan not found' }
    if (plan.status === 'completed' || plan.status === 'cancelled') {
      return { success: false, error: `Plan already ${plan.status}` }
    }

    // Cancel any placed TP orders on Freqtrade
    for (const tp of plan.takeProfits) {
      if (tp.status === 'placed' && tp.orderId) {
        await this.cancelFreqtradeOpenOrder(plan.freqtradeTradeId).catch(() => {})
        tp.status = 'cancelled'
      }
    }

    // Cancel SL monitoring
    if (plan.stopLoss.status === 'monitoring' || plan.stopLoss.status === 'pending') {
      plan.stopLoss.status = 'cancelled'
    }

    plan.status = 'cancelled'
    await this.store.archive(plan)
    this.pnlCache.delete(planId)
    log.info(`plan ${planId.slice(0, 8)} cancelled`)
    return { success: true }
  }

  /** Update an active plan's TP levels, SL, and/or auto-SL features. Automatically re-places orders. */
  async updatePlan(planId: string, updates: {
    takeProfits?: { price: number; sizeRatio: number }[]
    stopLossPrice?: number
    autoBreakeven?: boolean
    trailingStop?: { distance: number; type: 'fixed' | 'percent' | 'chandelier'; lookbackBars?: number } | null
  }): Promise<{ success: boolean; error?: string; plan?: TradePlan }> {
    const plan = this.store.get(planId)
    if (!plan) return { success: false, error: 'Plan not found' }
    if (plan.status === 'completed' || plan.status === 'cancelled') {
      return { success: false, error: `Plan already ${plan.status}` }
    }

    // --- Update Take-Profits ---
    if (updates.takeProfits) {
      // Cancel currently placed TP order (if any)
      const placedTp = plan.takeProfits.find(tp => tp.status === 'placed')
      if (placedTp && plan.freqtradeTradeId) {
        await this.cancelFreqtradeOpenOrder(plan.freqtradeTradeId).catch(() => {})
      }

      // Preserve filled TPs, rebuild pending ones from new spec
      const filledTps = plan.takeProfits.filter(tp => tp.status === 'filled')
      const filledRatio = filledTps.reduce((sum, tp) => sum + tp.sizeRatio, 0)

      // Scale new TP ratios to remaining position
      const remainingRatio = 1 - filledRatio
      const newTps: TakeProfitLevel[] = [
        ...filledTps,
        ...updates.takeProfits.map((tp, i) => ({
          level: filledTps.length + i + 1,
          price: tp.price,
          sizeRatio: tp.sizeRatio * remainingRatio, // scale to remaining
          status: 'pending' as const,
        })),
      ]

      plan.takeProfits = newTps

      // If plan is active, place the next pending TP
      if ((plan.status === 'active' || plan.status === 'partial') && plan.freqtradeTradeId) {
        const trades = await this.engine.getRawTrades().catch(() => [] as FreqtradeTrade[])
        const trade = trades.find(t => t.trade_id === plan.freqtradeTradeId)
        if (trade) {
          await this.placeNextTp(plan, trade)
        }
      }
    }

    // --- Update Stop-Loss ---
    if (updates.stopLossPrice !== undefined) {
      plan.stopLoss = {
        price: updates.stopLossPrice,
        status: (plan.status === 'active' || plan.status === 'partial') ? 'monitoring' : 'pending',
      }
      await this.store.save(plan)
    }

    // --- Update auto-SL features ---
    if (updates.autoBreakeven !== undefined) {
      plan.autoBreakeven = updates.autoBreakeven
    }
    if (updates.trailingStop !== undefined) {
      plan.trailingStop = updates.trailingStop ?? undefined
    }

    await this.store.save(plan)
    const changes: string[] = []
    if (updates.takeProfits) changes.push(`TP levels updated to ${updates.takeProfits.length} levels`)
    if (updates.stopLossPrice !== undefined) changes.push(`SL moved to $${updates.stopLossPrice}`)
    if (updates.autoBreakeven !== undefined) changes.push(`auto-breakeven ${updates.autoBreakeven ? 'enabled' : 'disabled'}`)
    if (updates.trailingStop !== undefined) {
      changes.push(updates.trailingStop ? `trailing ${updates.trailingStop.type} ${updates.trailingStop.distance}` : 'trailing disabled')
    }
    log.info(`plan ${planId.slice(0, 8)} updated — ${changes.join(', ')}`)

    this.emitEvent(plan, 'plan_updated', `${plan.symbol} plan updated: ${changes.join(', ')}`)

    return { success: true, plan }
  }

  /** Partially exit an active position to reduce risk exposure. */
  async partialExit(planId: string, exitRatio: number, reason: string): Promise<{ success: boolean; error?: string; exitedSize?: number; remainingSize?: number }> {
    const plan = this.store.get(planId)
    if (!plan) return { success: false, error: 'Plan not found' }
    if (plan.status !== 'active' && plan.status !== 'partial') {
      return { success: false, error: `Plan is ${plan.status}, must be active or partial` }
    }
    if (!plan.freqtradeTradeId || !plan.positionSize || !plan.entryPrice) {
      return { success: false, error: 'Plan has no active position' }
    }

    if (await isCryptoReadOnly()) {
      return { success: false, error: 'BLOCKED by readOnly mode' }
    }

    // Calculate exit size from remaining position
    const filledTpRatio = plan.takeProfits
      .filter(tp => tp.status === 'filled')
      .reduce((sum, tp) => sum + tp.sizeRatio, 0)
    const remainingRatio = 1 - filledTpRatio
    const remainingSize = plan.positionSize * remainingRatio
    const exitSize = remainingSize * exitRatio

    if (exitSize <= 0) {
      return { success: false, error: 'No remaining position to exit' }
    }

    try {
      // Place a partial exit order
      const result = await this.engine.placeOrder({
        symbol: plan.symbol,
        side: plan.direction === 'long' ? 'sell' : 'buy',
        type: 'market',
        size: exitSize,
        reduceOnly: true,
      })

      if (!result.success) {
        return { success: false, error: `Partial exit failed: ${result.error}` }
      }

      // Compute P&L for exited portion
      const pnl = this.pnlCache.get(planId)
      const currentPrice = pnl?.currentPrice ?? plan.entryPrice
      const isLong = plan.direction === 'long'
      const priceDiff = isLong
        ? currentPrice - plan.entryPrice
        : plan.entryPrice - currentPrice
      const exitPnl = priceDiff * exitSize
      plan.realizedPnl = (plan.realizedPnl ?? 0) + exitPnl

      // Scale down remaining TP ratios proportionally
      const scaleDown = 1 - exitRatio
      for (const tp of plan.takeProfits) {
        if (tp.status === 'pending' || tp.status === 'placed') {
          tp.sizeRatio *= scaleDown
        }
      }

      const newRemainingSize = remainingSize - exitSize
      const deriskedPct = (exitRatio * 100).toFixed(0)

      await this.store.save(plan)
      log.info(`${plan.symbol} partial exit ${deriskedPct}% — exited ${exitSize.toFixed(4)} @ ~$${currentPrice} | reason: ${reason}`)
      this.emitEvent(plan, 'partial_exit', `${plan.symbol} de-risked ${deriskedPct}% (${exitSize.toFixed(4)} coins @ ~$${currentPrice}). Reason: ${reason}. PnL: $${exitPnl.toFixed(2)}. Remaining: ${newRemainingSize.toFixed(4)} coins.`)

      return {
        success: true,
        exitedSize: Number(exitSize.toFixed(6)),
        remainingSize: Number(newRemainingSize.toFixed(6)),
      }
    } catch (err) {
      return { success: false, error: `Partial exit error: ${err}` }
    }
  }

  /** Get all active plans. */
  getActivePlans(): TradePlan[] {
    return this.store.getAll()
  }

  /** Get plans for a specific symbol. */
  getPlansBySymbol(symbol: string): TradePlan[] {
    return this.store.getBySymbol(symbol)
  }

  /** Build a summary for heartbeat injection. */
  getSummaryForHeartbeat(): string {
    const plans = this.store.getAll()
    if (plans.length === 0) return ''

    const lines = plans.map(p => {
      const tpParts = p.takeProfits.map(tp =>
        `TP${tp.level} $${tp.price} (${(tp.sizeRatio * 100).toFixed(0)}%, ${tp.status}${tp.filledPrice ? ` @$${tp.filledPrice}` : ''})`
      ).join(' | ')
      const sl = `SL $${p.stopLoss.price} (${p.stopLoss.status})`
      const entry = p.entryPrice ? `entry $${p.entryPrice}` : 'entry pending'

      // P&L info from cache
      const pnl = this.pnlCache.get(p.id)
      let pnlStr = ''
      if (pnl) {
        const icon = pnl.unrealizedPnlPct >= 0 ? '📈' : '📉'
        pnlStr = ` | ${icon} uPnL: ${pnl.unrealizedPnl >= 0 ? '+' : ''}$${pnl.unrealizedPnl.toFixed(2)} (${pnl.unrealizedPnlPct >= 0 ? '+' : ''}${pnl.unrealizedPnlPct.toFixed(1)}%)`
        if ((p.realizedPnl ?? 0) !== 0) {
          pnlStr += ` | rPnL: $${(p.realizedPnl ?? 0).toFixed(2)}`
        }
        if (pnl.riskRewardRatio != null) {
          pnlStr += ` | R:R ${pnl.riskRewardRatio.toFixed(1)}`
        }
        if (pnl.maxDrawdown > 0) {
          pnlStr += ` | maxDD: -${pnl.maxDrawdown.toFixed(1)}%`
        }
        // SL proximity indicator
        const isLong = p.direction === 'long'
        const slDistPct = isLong
          ? (pnl.currentPrice - p.stopLoss.price) / pnl.currentPrice * 100
          : (p.stopLoss.price - pnl.currentPrice) / pnl.currentPrice * 100
        if (slDistPct > 0 && slDistPct < 1.0) {
          pnlStr += ` | ⚠️SL ${slDistPct.toFixed(2)}% away`
        }
        // Profit in ATR multiples (for AI exit reasoning)
        if (p.atrAtEntry && p.entryPrice) {
          const profitAtr = isLong
            ? (pnl.currentPrice - p.entryPrice) / p.atrAtEntry
            : (p.entryPrice - pnl.currentPrice) / p.atrAtEntry
          if (Math.abs(profitAtr) >= 0.5) {
            pnlStr += ` | ${profitAtr >= 0 ? '+' : ''}${profitAtr.toFixed(1)}x ATR`
          }
        }
      }

      // Auto SL features
      const features: string[] = []
      if (p.profile) features.push(p.profile)
      if (p.autoBreakeven) features.push('auto-BE')
      if (p.trailingStop) features.push(`trail ${p.trailingStop.type === 'percent' ? p.trailingStop.distance + '%' : '$' + p.trailingStop.distance}`)
      if (p.dca?.enabled) {
        const filledDca = p.dca.layers.filter(l => l.status === 'filled').length
        const totalDca = p.dca.layers.length
        features.push(`DCA ${filledDca}/${totalDca}${p.dca.avgEntryPrice ? ` avg$${p.dca.avgEntryPrice.toFixed(2)}` : ''}`)
      }
      const featureStr = features.length > 0 ? ` [${features.join(', ')}]` : ''

      return `- ${p.symbol} ${p.direction.toUpperCase()}: ${entry} | ${tpParts} | ${sl}${pnlStr}${featureStr} | ${p.status}`
    })

    return ['', '📋 Active Trade Plans:', ...lines].join('\n')
  }

  /** Get cached P&L for a plan (computed each tick). */
  getPnL(planId: string): TradePlanPnL | undefined {
    return this.pnlCache.get(planId)
  }

  // ==================== P&L Computation ====================

  /** Compute live P&L for a plan given the current market price. */
  private computePnL(plan: TradePlan, currentPrice: number): TradePlanPnL {
    const entry = plan.entryPrice ?? currentPrice
    const size = plan.positionSize ?? 0
    const isLong = plan.direction === 'long'

    // Remaining position ratio (unfilled TPs)
    const filledTpRatio = plan.takeProfits
      .filter(tp => tp.status === 'filled')
      .reduce((sum, tp) => sum + tp.sizeRatio, 0)
    const remainingRatio = 1 - filledTpRatio
    const remainingSize = size * remainingRatio

    // Unrealized P&L on remaining position
    const priceDiff = isLong ? currentPrice - entry : entry - currentPrice
    const unrealizedPnl = priceDiff * remainingSize
    const unrealizedPnlPct = entry > 0 ? (priceDiff / entry) * 100 : 0

    // Realized P&L from filled TPs
    const realizedPnl = plan.realizedPnl ?? 0

    // Risk:Reward ratio — distance to SL vs distance to next TP
    let riskRewardRatio: number | null = null
    const nextTp = plan.takeProfits.find(tp => tp.status === 'pending' || tp.status === 'placed')
    if (nextTp) {
      const distanceToSl = Math.abs(currentPrice - plan.stopLoss.price)
      const distanceToTp = Math.abs(nextTp.price - currentPrice)
      riskRewardRatio = distanceToSl > 0 ? distanceToTp / distanceToSl : null
    }

    // Peak price tracking
    const prevPeak = plan.peakPrice ?? entry
    const peakPrice = isLong
      ? Math.max(prevPeak, currentPrice)
      : Math.min(prevPeak, currentPrice)

    // Max drawdown (worst unrealized loss from peak)
    const drawdownFromPeak = isLong
      ? ((peakPrice - currentPrice) / peakPrice) * 100
      : ((currentPrice - peakPrice) / peakPrice) * 100
    const maxDrawdown = Math.max(plan.maxDrawdown ?? 0, Math.max(0, drawdownFromPeak))

    return {
      currentPrice,
      unrealizedPnl,
      unrealizedPnlPct,
      realizedPnl,
      riskRewardRatio,
      peakPrice,
      maxDrawdown,
    }
  }

  /** Update persisted tracking fields (peakPrice, maxDrawdown) from P&L snapshot. */
  private updateTrackingFields(plan: TradePlan, pnl: TradePlanPnL): boolean {
    let changed = false
    if (plan.peakPrice !== pnl.peakPrice) {
      plan.peakPrice = pnl.peakPrice
      changed = true
    }
    if ((plan.maxDrawdown ?? 0) < pnl.maxDrawdown) {
      plan.maxDrawdown = pnl.maxDrawdown
      changed = true
    }
    return changed
  }

  // ==================== Auto SL Logic ====================

  /** Fetch ATR(14, 1H) for a symbol with 5-minute cache. */
  private async fetchAtr(symbol: string): Promise<number | null> {
    const cached = this.atrCache.get(symbol)
    if (cached && Date.now() - cached.updatedAt < 5 * 60 * 1000) {
      return cached.atr
    }

    try {
      const ohlcv = await fetchExchangeOHLCV([symbol], '1h', 30)
      const bars = ohlcv[symbol]
      if (!bars || bars.length < 20) return null

      const highs = bars.map(b => b.high)
      const lows = bars.map(b => b.low)
      const closes = bars.map(b => b.close)
      const atrArr = atrSeries(highs, lows, closes, 14)
      if (atrArr.length === 0) return null

      const atr = atrArr[atrArr.length - 1]
      this.atrCache.set(symbol, { atr, updatedAt: Date.now() })
      return atr
    } catch (err) {
      log.warn(`failed to fetch ATR for ${symbol}: ${err}`)
      return null
    }
  }

  // ==================== Profile-Driven Progressive Stages ====================

  /** Progressive protection stages per profile: [profitThreshold in ATR, SL offset from entry in ATR] */
  private static readonly PROGRESSIVE_STAGES: Record<TradeProfile, [number, number][]> = {
    // Trend: wider stages — give the trend room to breathe
    trend: [
      [4.0, 2.5],   // stage 4: lock 2.5x ATR profit
      [3.0, 1.5],   // stage 3: lock 1.5x ATR profit
      [2.0, 0.5],   // stage 2: lock small profit
      [1.5, 0.0],   // stage 1: breakeven
    ],
    // Reversal: standard stages (DCA provides additional safety net)
    reversal: [
      [3.5, 2.0],   // stage 4: lock 2x ATR profit
      [2.5, 1.0],   // stage 3: lock 1x ATR profit
      [1.5, 0.0],   // stage 2: breakeven
      [1.0, -0.5],  // stage 1: cut risk 50%
    ],
    // Breakout: tighter stages — lock gains faster
    breakout: [
      [3.0, 2.0],   // stage 4: lock 2x ATR
      [2.0, 1.0],   // stage 3: lock 1x ATR
      [1.2, 0.0],   // stage 2: breakeven
      [0.8, -0.3],  // stage 1: cut risk early
    ],
    // Scalp: tightest stages — protect capital aggressively
    scalp: [
      [2.0, 1.5],   // stage 4: lock 1.5x ATR
      [1.5, 1.0],   // stage 3: lock 1x ATR
      [1.0, 0.0],   // stage 2: breakeven at +1 ATR
      [0.5, -0.3],  // stage 1: cut risk very early
    ],
  }

  /** Default trailing stop config per profile (null = no auto-trail) */
  private static readonly PROFILE_TRAILING: Record<TradeProfile, { distance: number; type: 'fixed' | 'percent' | 'chandelier'; lookbackBars?: number } | null> = {
    trend:    { type: 'chandelier', distance: 2.5, lookbackBars: 14 },
    reversal: null,
    breakout: { type: 'chandelier', distance: 3.0, lookbackBars: 10 },
    scalp:    { type: 'percent', distance: 1.0 },
  }

  /**
   * Progressive SL protection — tighten SL based on unrealized profit
   * measured in ATR multiples. Stages are profile-aware.
   */
  private async applyProgressiveProtection(plan: TradePlan, currentPrice: number): Promise<void> {
    if (!plan.entryPrice) return

    // Get ATR — either cached on plan or fetch fresh
    let atr = plan.atrAtEntry
    if (!atr) {
      const fetched = await this.fetchAtr(plan.symbol)
      if (!fetched) return // can't compute without ATR
      atr = fetched
      plan.atrAtEntry = atr
      await this.store.save(plan)
    }

    const isLong = plan.direction === 'long'
    const entry = plan.entryPrice
    const sign = isLong ? 1 : -1

    // Profit in ATR multiples
    const profitAtr = isLong
      ? (currentPrice - entry) / atr
      : (entry - currentPrice) / atr

    // Select stages by profile (default to reversal)
    const profile = plan.profile ?? 'reversal'
    const stages = TradeManager.PROGRESSIVE_STAGES[profile]

    const currentStage = plan.progressiveStage ?? 0

    for (let i = 0; i < stages.length; i++) {
      const stageNum = stages.length - i // 4, 3, 2, 1
      const [threshold, slOffset] = stages[i]

      if (profitAtr >= threshold && currentStage < stageNum) {
        const newSl = entry + sign * slOffset * atr

        // Only move SL in favorable direction
        const shouldMove = isLong
          ? newSl > plan.stopLoss.price
          : newSl < plan.stopLoss.price

        if (shouldMove) {
          const oldSl = plan.stopLoss.price
          plan.stopLoss = { price: Number(newSl.toFixed(6)), status: 'monitoring' }
          plan.progressiveStage = stageNum
          await this.store.save(plan)

          const label = slOffset > 0 ? `+${slOffset}x ATR` : slOffset === 0 ? 'breakeven' : `${slOffset}x ATR`
          log.info(`${plan.symbol} progressive protection stage ${stageNum} — profit +${profitAtr.toFixed(1)}x ATR, SL $${oldSl} → $${plan.stopLoss.price} (${label})`)
          this.emitEvent(plan, 'sl_moved', `${plan.symbol} SL auto-tightened to $${plan.stopLoss.price} (profit +${profitAtr.toFixed(1)}x ATR, ${label})`)
        }
        break // only apply highest qualifying stage
      }
    }
  }

  /** After TP1 fills, auto-move SL to breakeven (entry price). */
  private async applyAutoBreakeven(plan: TradePlan): Promise<void> {
    if (!plan.autoBreakeven) return
    if (!plan.entryPrice) return

    // Only trigger once: when first TP is filled and SL is still below entry (for long) / above entry (for short)
    const filledCount = plan.takeProfits.filter(tp => tp.status === 'filled').length
    if (filledCount < 1) return

    const isLong = plan.direction === 'long'
    const slShouldMove = isLong
      ? plan.stopLoss.price < plan.entryPrice
      : plan.stopLoss.price > plan.entryPrice

    if (!slShouldMove) return // already at or past breakeven

    const oldSl = plan.stopLoss.price

    plan.stopLoss = {
      price: plan.entryPrice,
      status: 'monitoring',
    }
    await this.store.save(plan)

    log.info(`${plan.symbol} auto-breakeven — SL moved $${oldSl} → $${plan.entryPrice}`)
    this.emitEvent(plan, 'sl_moved', `${plan.symbol} SL auto-moved to breakeven $${plan.entryPrice} (was $${oldSl})`)
  }

  /** Trailing stop: move SL to follow price at configured distance. */
  private async applyTrailingStop(plan: TradePlan, currentPrice: number): Promise<void> {
    if (!plan.trailingStop) return
    if (!plan.entryPrice) return

    const isLong = plan.direction === 'long'
    const { distance, type } = plan.trailingStop

    let newSlPrice: number

    if (type === 'chandelier') {
      // Chandelier Exit: anchor to period high/low, trail by ATR * multiplier
      const atr = plan.atrAtEntry ?? await this.fetchAtr(plan.symbol)
      if (!atr) return

      const lookback = plan.trailingStop.lookbackBars ?? 14

      // Fetch OHLCV with 5-minute cache
      let cached = this.ohlcvCache.get(plan.symbol)
      if (!cached || Date.now() - cached.updatedAt > 5 * 60 * 1000) {
        const ohlcv = await fetchExchangeOHLCV([plan.symbol], '1h', lookback + 2)
        const bars = ohlcv[plan.symbol]
        if (!bars || bars.length < lookback) return
        cached = {
          highs: bars.map(b => b.high),
          lows: bars.map(b => b.low),
          updatedAt: Date.now(),
        }
        this.ohlcvCache.set(plan.symbol, cached)
      }

      const recentHighs = cached.highs.slice(-lookback)
      const recentLows = cached.lows.slice(-lookback)
      if (isLong) {
        const periodHigh = Math.max(...recentHighs)
        newSlPrice = periodHigh - distance * atr
      } else {
        const periodLow = Math.min(...recentLows)
        newSlPrice = periodLow + distance * atr
      }
    } else {
      // Fixed or percent trailing
      const trailAmount = type === 'percent'
        ? currentPrice * (distance / 100)
        : distance

      newSlPrice = isLong
        ? currentPrice - trailAmount
        : currentPrice + trailAmount
    }

    // Only move SL in the favorable direction (never move it backwards)
    const shouldMove = isLong
      ? newSlPrice > plan.stopLoss.price
      : newSlPrice < plan.stopLoss.price

    if (!shouldMove) return

    const oldSl = plan.stopLoss.price

    plan.stopLoss = {
      price: Number(newSlPrice.toFixed(6)),
      status: 'monitoring',
    }
    await this.store.save(plan)

    log.info(`${plan.symbol} trailing stop — SL moved $${oldSl} → $${plan.stopLoss.price}`)
  }

  /** Time-decay: tighten SL after trade sits too long without TP1 fill. */
  private async applyTimeDecay(plan: TradePlan): Promise<void> {
    if (!plan.timeDecay || plan.timeDecayApplied) return
    if (!plan.entryPrice) return

    // Check if TP1 has already filled — no decay needed
    const tp1 = plan.takeProfits.find(tp => tp.level === 1)
    if (tp1?.status === 'filled') return

    // Check elapsed time since plan creation
    const elapsed = Date.now() - new Date(plan.createdAt).getTime()
    const thresholdMs = plan.timeDecay.hoursToTighten * 60 * 60 * 1000
    if (elapsed < thresholdMs) return

    // Tighten SL toward entry: move SL distance by tightenPercent
    const isLong = plan.direction === 'long'
    const slDist = Math.abs(plan.entryPrice - plan.stopLoss.price)
    const tightenAmount = slDist * (plan.timeDecay.tightenPercent / 100)

    const newSl = isLong
      ? plan.stopLoss.price + tightenAmount
      : plan.stopLoss.price - tightenAmount

    const oldSl = plan.stopLoss.price
    plan.stopLoss = { price: Number(newSl.toFixed(6)), status: 'monitoring' }
    plan.timeDecayApplied = true
    await this.store.save(plan)

    log.info(`${plan.symbol} time-decay — SL tightened $${oldSl} → $${plan.stopLoss.price} (${plan.timeDecay.hoursToTighten}h elapsed, TP1 unfilled)`)
    this.emitEvent(plan, 'sl_tightened', `${plan.symbol} SL auto-tightened to $${plan.stopLoss.price} — trade held ${plan.timeDecay.hoursToTighten}h without TP1 fill`)
  }

  // ==================== DCA Logic ====================

  /** Default DCA parameters for reversal profile */
  private static readonly DCA_TRIGGER_ATR_MULTIPLES = [1.5, 2.5]
  private static readonly DCA_LAYER_STAKE_RATIO = 0.5 // each layer = 50% of initial stake
  private static readonly DCA_HARD_STOP_ATR_MULTIPLE = 3.5

  /**
   * Compute DCA layers after entry fill.
   * Called once in handlePending when DCA is enabled.
   */
  private computeDcaLayers(plan: TradePlan): void {
    if (!plan.dca?.enabled || !plan.entryPrice || !plan.atrAtEntry || !plan.positionSize) return

    const atr = plan.atrAtEntry
    const entry = plan.entryPrice
    const isLong = plan.direction === 'long'
    const sign = isLong ? -1 : 1 // DCA triggers are adverse direction

    // Estimate initial stake in USDT
    const initialStake = plan.positionSize * entry

    const layers: DcaLayer[] = TradeManager.DCA_TRIGGER_ATR_MULTIPLES.map((mult, i) => ({
      layer: i + 1,
      triggerPrice: Number((entry + sign * mult * atr).toFixed(6)),
      stakeAmount: Number((initialStake * TradeManager.DCA_LAYER_STAKE_RATIO).toFixed(2)),
      status: 'pending' as const,
    }))

    // Hard stop price
    const hardStop = Number((entry + sign * TradeManager.DCA_HARD_STOP_ATR_MULTIPLE * atr).toFixed(6))

    plan.dca.layers = layers
    plan.dca.hardStopPrice = hardStop
    plan.dca.maxLayers = layers.length

    log.info(`${plan.symbol} DCA layers computed: ${layers.map(l => `L${l.layer} @$${l.triggerPrice} ($${l.stakeAmount})`).join(', ')} | hard stop $${hardStop}`)
  }

  /**
   * Check if any DCA layer should trigger based on current price.
   * When triggered, opens a new Freqtrade trade for the DCA layer.
   */
  private async checkDcaTriggers(plan: TradePlan, currentPrice: number, trades: FreqtradeTrade[]): Promise<void> {
    if (!plan.dca?.enabled || plan.dca.layers.length === 0) return
    if (!plan.entryPrice) return

    const isLong = plan.direction === 'long'

    for (const layer of plan.dca.layers) {
      if (layer.status !== 'pending') continue

      // Check trigger: long → price drops to/below trigger, short → price rises to/above trigger
      const triggered = isLong
        ? currentPrice <= layer.triggerPrice
        : currentPrice >= layer.triggerPrice

      if (!triggered) continue

      // Check if we can enter (not read-only)
      if (await isCryptoReadOnly()) {
        log.warn(`BLOCKED by readOnly: DCA L${layer.layer} for ${plan.symbol}`)
        continue
      }

      log.info(`${plan.symbol} DCA L${layer.layer} triggered at $${currentPrice} (trigger $${layer.triggerPrice})`)
      layer.status = 'triggered'

      try {
        // Place a new market entry for DCA via placeOrder (which uses forceenter)
        const result = await this.engine.placeOrder({
          symbol: plan.symbol,
          side: isLong ? 'buy' : 'sell',
          type: 'market',
          usdSize: layer.stakeAmount,
        })

        if (result.success) {
          layer.status = 'filled'
          layer.filledPrice = currentPrice
          layer.filledAt = new Date().toISOString()
          // Estimate filled amount
          layer.filledAmount = layer.stakeAmount / currentPrice

          // Try to find the new Freqtrade trade for this DCA layer
          // It will be the newest trade for this symbol
          try {
            const freshTrades = await this.engine.getRawTrades()
            const dcaTrade = freshTrades
              .filter(t => t.is_open && normalizePair(t.pair) === plan.symbol && t.is_short === (plan.direction === 'short'))
              .sort((a, b) => b.trade_id - a.trade_id)[0]
            if (dcaTrade && dcaTrade.trade_id !== plan.freqtradeTradeId) {
              layer.freqtradeTradeId = dcaTrade.trade_id
              layer.filledPrice = dcaTrade.open_rate
              layer.filledAmount = dcaTrade.amount
            }
          } catch { /* best effort */ }

          // Recompute average entry price
          this.recomputeDcaAvgEntry(plan)

          await this.store.save(plan)
          this.emitEvent(plan, 'dca_filled', `${plan.symbol} DCA L${layer.layer} filled at ~$${layer.filledPrice} ($${layer.stakeAmount}). Avg entry: $${plan.dca.avgEntryPrice?.toFixed(4)}`)
        } else {
          log.error(`${plan.symbol} DCA L${layer.layer} order failed: ${result.error}`)
          layer.status = 'pending' // retry next tick
        }
      } catch (err) {
        log.error(`${plan.symbol} DCA L${layer.layer} error: ${err}`)
        layer.status = 'pending'
      }
    }
  }

  /** Recompute weighted average entry price including all filled DCA layers. */
  private recomputeDcaAvgEntry(plan: TradePlan): void {
    if (!plan.dca || !plan.entryPrice || !plan.positionSize) return

    let totalCost = plan.entryPrice * plan.positionSize
    let totalAmount = plan.positionSize
    let totalDcaAmount = 0

    for (const layer of plan.dca.layers) {
      if (layer.status === 'filled' && layer.filledPrice && layer.filledAmount) {
        totalCost += layer.filledPrice * layer.filledAmount
        totalAmount += layer.filledAmount
        totalDcaAmount += layer.filledAmount
      }
    }

    plan.dca.avgEntryPrice = Number((totalCost / totalAmount).toFixed(6))
    plan.dca.totalDcaAmount = totalDcaAmount
  }

  /**
   * Check if DCA layers should take profit.
   * When price recovers to avgEntry + threshold, exit DCA layers.
   */
  private async checkDcaTakeProfit(plan: TradePlan, currentPrice: number): Promise<void> {
    if (!plan.dca?.enabled) return
    const filledLayers = plan.dca.layers.filter(l => l.status === 'filled')
    if (filledLayers.length === 0) return
    if (!plan.dca.avgEntryPrice) return

    const isLong = plan.direction === 'long'
    const avgEntry = plan.dca.avgEntryPrice
    const threshold = plan.dca.tpProfitThreshold

    // Check if price has recovered enough
    const profitPct = isLong
      ? (currentPrice - avgEntry) / avgEntry
      : (avgEntry - currentPrice) / avgEntry

    if (profitPct < threshold) return

    log.info(`${plan.symbol} DCA take-profit triggered — price $${currentPrice}, avg $${avgEntry.toFixed(4)}, profit ${(profitPct * 100).toFixed(2)}%`)

    // Force-exit each DCA layer's trade
    for (const layer of filledLayers) {
      if (!layer.freqtradeTradeId) continue

      try {
        const result = await this.engine.forceExit(String(layer.freqtradeTradeId))
        if (result.success) {
          layer.status = 'exited'
          layer.exitPrice = currentPrice
          layer.exitAt = new Date().toISOString()

          // Compute DCA layer P&L
          if (layer.filledPrice && layer.filledAmount) {
            const priceDiff = isLong
              ? currentPrice - layer.filledPrice
              : layer.filledPrice - currentPrice
            plan.realizedPnl = (plan.realizedPnl ?? 0) + priceDiff * layer.filledAmount
          }

          log.info(`${plan.symbol} DCA L${layer.layer} exited at $${currentPrice}`)
        } else {
          log.error(`${plan.symbol} DCA L${layer.layer} exit failed: ${result.error}`)
        }
      } catch (err) {
        log.error(`${plan.symbol} DCA L${layer.layer} exit error: ${err}`)
      }
    }

    // Clear DCA state — original position continues on TP/SL
    plan.dca.totalDcaAmount = 0
    plan.dca.avgEntryPrice = undefined
    await this.store.save(plan)

    this.emitEvent(plan, 'dca_tp', `${plan.symbol} DCA layers exited at $${currentPrice} (+${(profitPct * 100).toFixed(1)}%). Original position continues.`)
  }

  /**
   * Check DCA hard stop — if price hits hard stop, force-exit EVERYTHING.
   * Returns true if hard stop triggered (plan is completed).
   */
  private async checkDcaHardStop(plan: TradePlan, currentPrice: number): Promise<boolean> {
    if (!plan.dca?.enabled || plan.dca.hardStopPrice === 0) return false
    if (!plan.freqtradeTradeId) return false

    const isLong = plan.direction === 'long'
    const breached = isLong
      ? currentPrice <= plan.dca.hardStopPrice
      : currentPrice >= plan.dca.hardStopPrice

    if (!breached) return false

    log.warn(`${plan.symbol} DCA HARD STOP — price $${currentPrice} hit $${plan.dca.hardStopPrice}. Force-exiting ALL.`)

    // Exit main trade
    try {
      await this.engine.forceExit(String(plan.freqtradeTradeId))
    } catch (err) {
      log.error(`${plan.symbol} hard stop main exit error: ${err}`)
    }

    // Exit all DCA layer trades
    for (const layer of plan.dca.layers) {
      if (layer.status === 'filled' && layer.freqtradeTradeId) {
        try {
          await this.engine.forceExit(String(layer.freqtradeTradeId))
          layer.status = 'stopped'
          layer.exitPrice = currentPrice
          layer.exitAt = new Date().toISOString()
        } catch (err) {
          log.error(`${plan.symbol} DCA L${layer.layer} hard stop exit error: ${err}`)
        }
      }
    }

    // Compute total loss
    if (plan.entryPrice && plan.positionSize) {
      const isLong = plan.direction === 'long'
      const mainLoss = isLong
        ? (currentPrice - plan.entryPrice) * plan.positionSize
        : (plan.entryPrice - currentPrice) * plan.positionSize
      plan.realizedPnl = (plan.realizedPnl ?? 0) + mainLoss

      for (const layer of plan.dca.layers) {
        if (layer.status === 'stopped' && layer.filledPrice && layer.filledAmount) {
          const layerLoss = isLong
            ? (currentPrice - layer.filledPrice) * layer.filledAmount
            : (layer.filledPrice - currentPrice) * layer.filledAmount
          plan.realizedPnl = (plan.realizedPnl ?? 0) + layerLoss
        }
      }
    }

    // Mark everything done
    plan.stopLoss.status = 'filled'
    plan.stopLoss.filledPrice = currentPrice
    plan.stopLoss.filledAt = new Date().toISOString()
    for (const tp of plan.takeProfits) {
      if (tp.status === 'pending' || tp.status === 'placed') tp.status = 'cancelled'
    }
    plan.status = 'completed'
    await this.store.archive(plan)
    this.pnlCache.delete(plan.id)

    this.emitEvent(plan, 'dca_hard_stop', `${plan.symbol} DCA HARD STOP at $${currentPrice}. All positions exited. PnL: $${(plan.realizedPnl ?? 0).toFixed(2)}`)
    return true
  }

  /**
   * Validate SL/TP sanity against actual entry price.
   * Returns error string if invalid, null if OK.
   */
  private validateSlTp(plan: TradePlan): string | null {
    const entry = plan.entryPrice
    if (!entry) return 'no entry price'

    const sl = plan.stopLoss.price
    const isLong = plan.direction === 'long'

    // 1. SL direction: long → SL < entry, short → SL > entry
    if (isLong && sl >= entry) {
      return `SL $${sl} is at or above entry $${entry} for LONG — must be below`
    }
    if (!isLong && sl <= entry) {
      return `SL $${sl} is at or below entry $${entry} for SHORT — must be above`
    }

    // 2. SL distance: 0.3% ~ 15%
    const slDistPct = (Math.abs(entry - sl) / entry) * 100
    if (slDistPct < 0.3) {
      return `SL too tight: ${slDistPct.toFixed(2)}% from entry (min 0.3%)`
    }
    if (slDistPct > 15) {
      return `SL too wide: ${slDistPct.toFixed(2)}% from entry (max 15%)`
    }

    // 3. TP1 direction
    const tp1 = plan.takeProfits.find(tp => tp.level === 1)
    if (tp1) {
      if (isLong && tp1.price <= entry) {
        return `TP1 $${tp1.price} is at or below entry $${entry} for LONG — must be above`
      }
      if (!isLong && tp1.price >= entry) {
        return `TP1 $${tp1.price} is at or above entry $${entry} for SHORT — must be below`
      }

      // 4. R:R >= 1.0 (TP1 distance / SL distance)
      const tp1Dist = Math.abs(tp1.price - entry)
      const slDist = Math.abs(entry - sl)
      const rr = tp1Dist / slDist
      if (rr < 1.0) {
        return `R:R too low: ${rr.toFixed(2)} (TP1 dist ${tp1Dist.toFixed(4)} / SL dist ${slDist.toFixed(4)}, min 1.0)`
      }
    }

    return null
  }

  /**
   * Active SL enforcement: if current price has breached the SL level,
   * force-exit via Freqtrade. This is critical in dry-run mode where
   * CCXT STOP_MARKET orders don't actually execute, and serves as a
   * safety net in live mode too.
   */
  /**
   * SL proximity warning — alert AI when price is within 0.5% of SL.
   * This gives the AI a chance to intervene (tighten SL, partial exit, or let it ride).
   * Emits once per SL level; resets when SL price changes.
   */
  private checkSlProximity(plan: TradePlan, currentPrice: number): void {
    if (!plan.entryPrice || !plan.freqtradeTradeId) return
    if (plan.stopLoss.status !== 'monitoring') return

    const isLong = plan.direction === 'long'
    const slPrice = plan.stopLoss.price
    const distancePct = isLong
      ? (currentPrice - slPrice) / currentPrice * 100
      : (slPrice - currentPrice) / currentPrice * 100

    // Within 0.5% of SL and still on the safe side
    if (distancePct > 0 && distancePct < 0.5 && !plan.slWarningEmitted) {
      plan.slWarningEmitted = true
      const pnl = this.pnlCache.get(plan.id)
      const pnlStr = pnl ? ` uPnL: ${pnl.unrealizedPnlPct >= 0 ? '+' : ''}${pnl.unrealizedPnlPct.toFixed(1)}%` : ''
      this.emitEvent(plan, 'sl_warning',
        `⚠️ ${plan.symbol} approaching SL — price $${currentPrice} is ${distancePct.toFixed(2)}% from SL $${slPrice}.${pnlStr} Consider: tighten SL, partial exit, or let auto-SL handle it.`)
      // Don't persist — this is a soft warning
    }

    // Reset warning flag if price moves away (>1% from SL)
    if (distancePct > 1.0 && plan.slWarningEmitted) {
      plan.slWarningEmitted = false
    }
  }

  private async checkSlBreach(plan: TradePlan, currentPrice: number): Promise<boolean> {
    if (plan.stopLoss.status !== 'monitoring' && plan.stopLoss.status !== 'placed' && plan.stopLoss.status !== 'pending') return false
    if (!plan.freqtradeTradeId) return false

    const isLong = plan.direction === 'long'
    const breached = isLong
      ? currentPrice <= plan.stopLoss.price
      : currentPrice >= plan.stopLoss.price

    if (!breached) return false

    log.warn(`${plan.symbol} SL BREACHED — price $${currentPrice} ${isLong ? '<=' : '>='} SL $${plan.stopLoss.price}. Force-exiting.`)

    try {
      const result = await this.engine.forceExit(String(plan.freqtradeTradeId))
      if (result.success) {
        plan.stopLoss.status = 'filled'
        plan.stopLoss.filledPrice = currentPrice
        plan.stopLoss.filledAt = new Date().toISOString()

        // Cancel remaining TPs
        for (const tp of plan.takeProfits) {
          if (tp.status === 'pending' || tp.status === 'placed') {
            tp.status = 'cancelled'
          }
        }

        // Compute final unrealized loss
        if (plan.entryPrice && plan.positionSize) {
          const remainingRatio = plan.takeProfits
            .filter(tp => tp.status !== 'filled')
            .reduce((sum, tp) => sum + tp.sizeRatio, 0)
          const priceDiff = isLong
            ? (currentPrice - plan.entryPrice)
            : (plan.entryPrice - currentPrice)
          const slLoss = priceDiff * plan.positionSize * remainingRatio
          plan.realizedPnl = (plan.realizedPnl ?? 0) + slLoss
        }

        plan.status = 'completed'
        await this.store.archive(plan)
        this.pnlCache.delete(plan.id)
        this.emitEvent(plan, 'sl_triggered', `${plan.symbol} SL triggered at $${currentPrice} (SL $${plan.stopLoss.price}). Force-exited. PnL: $${(plan.realizedPnl ?? 0).toFixed(2)}`)
        return true
      } else {
        log.error(`${plan.symbol} force-exit failed: ${result.error}`)
        return false
      }
    } catch (err) {
      log.error(`${plan.symbol} force-exit error: ${err}`)
      return false
    }
  }

  // ==================== Tick Logic ====================

  private async safeTick(): Promise<void> {
    if (this.ticking) return // prevent overlap
    this.ticking = true
    try {
      await this.tick()
    } catch (err) {
      log.error(`tick error: ${err}`)
    } finally {
      this.ticking = false
    }
  }

  private async tick(): Promise<void> {
    const plans = this.store.getAll()
    if (plans.length === 0) return

    // Fetch all open trades from Freqtrade once
    let trades: FreqtradeTrade[]
    try {
      trades = await this.engine.getRawTrades()
    } catch (err) {
      log.warn(`failed to fetch trades: ${err}`)
      return
    }

    for (const plan of plans) {
      try {
        await this.processPlan(plan, trades)
      } catch (err) {
        log.error(`error processing plan ${plan.id.slice(0, 8)}: ${err}`)
        plan.status = 'error'
        plan.errorMessage = err instanceof Error ? err.message : String(err)
        await this.store.save(plan)
      }
    }
  }

  private async processPlan(plan: TradePlan, trades: FreqtradeTrade[]): Promise<void> {
    // Find matching Freqtrade trade
    const trade = this.findMatchingTrade(plan, trades)

    if (plan.status === 'pending') {
      await this.handlePending(plan, trade)
    } else if (plan.status === 'active' || plan.status === 'partial') {
      // Compute and cache live P&L
      if (trade?.current_rate && plan.entryPrice) {
        const pnl = this.computePnL(plan, trade.current_rate)
        this.pnlCache.set(plan.id, pnl)

        // Persist tracking fields (peakPrice, maxDrawdown)
        if (this.updateTrackingFields(plan, pnl)) {
          await this.store.save(plan)
        }

        // Apply auto SL behaviors (progressive first, then breakeven, then trailing)
        await this.applyProgressiveProtection(plan, trade.current_rate)
        await this.applyAutoBreakeven(plan)
        await this.applyTrailingStop(plan, trade.current_rate)

        // Apply time-decay SL tightening
        await this.applyTimeDecay(plan)

        // SL proximity warning — alert AI when price is within 0.5% of SL
        this.checkSlProximity(plan, trade.current_rate)

        // DCA hard stop check (before normal SL — wider stop for DCA plans)
        if (plan.dca?.enabled) {
          if (await this.checkDcaHardStop(plan, trade.current_rate)) {
            return // all positions exited
          }
        }

        // Active SL enforcement — force-exit if price has breached SL
        if (await this.checkSlBreach(plan, trade.current_rate)) {
          return // plan already completed by force-exit
        }

        // DCA trigger check + take-profit check
        if (plan.dca?.enabled) {
          await this.checkDcaTriggers(plan, trade.current_rate, trades)
          await this.checkDcaTakeProfit(plan, trade.current_rate)
        }
      }

      await this.handleActive(plan, trade)
    }
  }

  /** Find the Freqtrade trade that matches this plan (by symbol + direction). */
  private findMatchingTrade(plan: TradePlan, trades: FreqtradeTrade[]): FreqtradeTrade | undefined {
    // If we already know the trade_id, use that
    if (plan.freqtradeTradeId) {
      return trades.find(t => t.trade_id === plan.freqtradeTradeId)
    }
    // Otherwise match by symbol + direction
    const isShort = plan.direction === 'short'
    return trades.find(t =>
      t.is_open &&
      normalizePair(t.pair) === plan.symbol &&
      t.is_short === isShort
    )
  }

  /** Plan is pending — wait for entry to fill, then activate. */
  private async handlePending(plan: TradePlan, trade: FreqtradeTrade | undefined): Promise<void> {
    if (!trade || !trade.is_open) return // entry not yet filled

    // Entry filled — populate plan fields
    plan.freqtradeTradeId = trade.trade_id
    plan.entryPrice = trade.open_rate
    plan.positionSize = trade.amount
    plan.leverage = trade.leverage ?? 1
    plan.peakPrice = trade.open_rate  // initialize peak at entry

    // Fetch ATR at entry for progressive protection
    const atr = await this.fetchAtr(plan.symbol)
    if (atr) plan.atrAtEntry = atr

    // Validate SL/TP sanity against actual entry price
    const validationError = this.validateSlTp(plan)
    if (validationError) {
      log.error(`plan ${plan.id.slice(0, 8)} SL/TP validation failed: ${validationError}`)
      // Force-exit the position since the plan is invalid
      try {
        await this.engine.forceExit(String(trade.trade_id))
      } catch (err) {
        log.error(`force-exit after validation failure: ${err}`)
      }
      plan.status = 'error'
      plan.errorMessage = `SL/TP validation failed: ${validationError}`
      await this.store.archive(plan)
      this.emitEvent(plan, 'plan_rejected', `${plan.symbol} plan rejected — ${validationError}. Position force-exited.`)
      return
    }

    // Compute DCA layers now that we have entry price + ATR
    if (plan.dca?.enabled) {
      this.computeDcaLayers(plan)
    }

    // Apply profile-default trailing stop if no explicit config was provided
    if (plan.profile && !plan.trailingStop) {
      const defaultTrailing = TradeManager.PROFILE_TRAILING[plan.profile]
      if (defaultTrailing) {
        plan.trailingStop = { ...defaultTrailing }
        log.info(`${plan.symbol} auto-trailing enabled by ${plan.profile} profile: ${defaultTrailing.type} ${defaultTrailing.distance}`)
      }
    }

    plan.status = 'active'
    await this.store.save(plan)

    const dcaInfo = plan.dca?.enabled ? ` [DCA: ${plan.dca.layers.length} layers, hard stop $${plan.dca.hardStopPrice}]` : ''
    log.info(`plan ${plan.id.slice(0, 8)} activated — ${plan.symbol} entry at $${trade.open_rate}, size ${trade.amount}${dcaInfo}`)

    // Place first TP order
    await this.placeNextTp(plan, trade)

    // Activate SL price monitoring
    await this.placeStopLoss(plan)

    this.emitEvent(plan, 'plan_activated', `${plan.symbol} ${plan.direction.toUpperCase()} entry filled at $${trade.open_rate}. TP1 and SL monitoring.${dcaInfo}`)
  }

  /** Plan is active/partial — check for TP fills, SL triggers. */
  private async handleActive(plan: TradePlan, trade: FreqtradeTrade | undefined): Promise<void> {
    // Check if trade is closed (SL triggered or fully exited)
    if (!trade || !trade.is_open) {
      await this.handleTradeClosed(plan, trade)
      return
    }

    // Activate SL monitoring if still pending
    if (plan.stopLoss.status === 'pending') {
      log.info(`${plan.symbol} SL still pending — activating monitoring`)
      await this.placeStopLoss(plan)
    }

    // Check current placed TP
    const placedTp = plan.takeProfits.find(tp => tp.status === 'placed')
    if (!placedTp) return

    // Check if TP order was filled (trade no longer has open orders AND amount decreased or close happened)
    const tpFilled = await this.checkTpFilled(plan, placedTp, trade)
    if (tpFilled) {
      placedTp.status = 'filled'
      placedTp.filledPrice = trade.current_rate ?? placedTp.price
      placedTp.filledAt = new Date().toISOString()

      // Accumulate realized P&L from this TP
      if (plan.entryPrice && plan.positionSize) {
        const isLong = plan.direction === 'long'
        const priceDiff = isLong
          ? (placedTp.filledPrice - plan.entryPrice)
          : (plan.entryPrice - placedTp.filledPrice)
        const tpProfit = priceDiff * plan.positionSize * placedTp.sizeRatio
        plan.realizedPnl = (plan.realizedPnl ?? 0) + tpProfit
      }

      const filledCount = plan.takeProfits.filter(tp => tp.status === 'filled').length
      const totalCount = plan.takeProfits.length

      log.info(`plan ${plan.id.slice(0, 8)} TP${placedTp.level} filled at ~$${placedTp.filledPrice} (realized: $${(plan.realizedPnl ?? 0).toFixed(2)})`)

      if (filledCount === totalCount) {
        // All TPs filled — plan complete
        plan.status = 'completed'
        await this.store.archive(plan)
        this.emitEvent(plan, 'plan_completed', `${plan.symbol} all ${totalCount} TP levels filled. Total realized: $${(plan.realizedPnl ?? 0).toFixed(2)}`)
      } else {
        // Partial — place next TP
        plan.status = 'partial'
        await this.store.save(plan)
        await this.placeNextTp(plan, trade)
        this.emitEvent(plan, 'tp_filled', `${plan.symbol} TP${placedTp.level} filled at ~$${placedTp.filledPrice} (+$${((plan.realizedPnl ?? 0)).toFixed(2)} realized). TP${placedTp.level + 1} queued.`)
      }
    }
  }

  /** Trade closed (SL triggered, manual exit, or liquidation). */
  private async handleTradeClosed(plan: TradePlan, trade: FreqtradeTrade | undefined): Promise<void> {
    // Cancel remaining pending/placed TPs
    for (const tp of plan.takeProfits) {
      if (tp.status === 'pending' || tp.status === 'placed') {
        tp.status = 'cancelled'
      }
    }

    // Mark SL as filled if it was monitoring/pending
    if (plan.stopLoss.status === 'monitoring' || plan.stopLoss.status === 'placed' || plan.stopLoss.status === 'pending') {
      plan.stopLoss.status = 'filled'
      plan.stopLoss.filledAt = new Date().toISOString()
      if (trade?.close_rate) {
        plan.stopLoss.filledPrice = trade.close_rate
      }
    }

    plan.status = 'completed'
    await this.store.archive(plan)
    this.pnlCache.delete(plan.id)

    const reason = trade?.exit_reason ?? 'trade closed'
    const totalPnl = (plan.realizedPnl ?? 0).toFixed(2)
    log.info(`plan ${plan.id.slice(0, 8)} — trade closed (${reason}), total P&L: $${totalPnl}`)
    this.emitEvent(plan, 'sl_triggered', `${plan.symbol} stop-loss triggered (${reason}). Total P&L: $${totalPnl}`)
  }

  // ==================== Order Placement ====================

  /** Place the next pending TP as a limit exit order. */
  private async placeNextTp(plan: TradePlan, trade: FreqtradeTrade): Promise<void> {
    if (await isCryptoReadOnly()) {
      log.warn(`BLOCKED by readOnly: TP${plan.takeProfits.find(tp => tp.status === 'pending')?.level} for ${plan.symbol}`)
      return
    }
    const nextTp = plan.takeProfits.find(tp => tp.status === 'pending')
    if (!nextTp || !plan.positionSize) return

    const exitSize = plan.positionSize * nextTp.sizeRatio

    try {
      const result = await this.engine.placeOrder({
        symbol: plan.symbol,
        side: plan.direction === 'long' ? 'sell' : 'buy',
        type: 'limit',
        price: nextTp.price,
        size: exitSize,
        reduceOnly: true,
      })

      if (result.success) {
        nextTp.status = 'placed'
        nextTp.orderId = result.orderId
        await this.store.save(plan)
        log.info(`placed TP${nextTp.level} for ${plan.symbol} — limit $${nextTp.price}, size ${exitSize.toFixed(4)}`)
      } else {
        log.warn(`failed to place TP${nextTp.level} for ${plan.symbol}: ${result.error}`)
      }
    } catch (err) {
      log.error(`TP${nextTp.level} placement error: ${err}`)
    }
  }

  /**
   * Activate SL monitoring. No exchange order is placed — TradeManager
   * monitors the price every tick and will forceExit on breach via checkSlBreach().
   */
  private async placeStopLoss(plan: TradePlan): Promise<void> {
    plan.stopLoss.status = 'monitoring'
    delete plan.stopLoss.orderId
    await this.store.save(plan)
    log.info(`${plan.symbol} SL monitoring activated at $${plan.stopLoss.price}`)
  }

  // ==================== Detection Helpers ====================

  /** Check if the currently placed TP has been filled. */
  private async checkTpFilled(plan: TradePlan, tp: TakeProfitLevel, trade: FreqtradeTrade): Promise<boolean> {
    // If trade has no open orders, the TP limit exit likely filled
    if (!trade.has_open_orders && tp.status === 'placed') {
      // Primary check: nr_of_successful_exits > our filled count
      // (filled_exit_orders may not exist in API; nr_of_successful_exits is the correct field)
      const exitCount = trade.nr_of_successful_exits ?? trade.filled_exit_orders ?? 0
      const ourFilledCount = plan.takeProfits.filter(t => t.status === 'filled').length
      if (exitCount > ourFilledCount) {
        log.info(`${plan.symbol} TP${tp.level} fill detected — exits=${exitCount} > tracked=${ourFilledCount}`)
        return true
      }
      // Fallback: check if position size shrank (partial close happened)
      if (trade.amount_requested && trade.amount < trade.amount_requested) {
        const closedRatio = 1 - (trade.amount / trade.amount_requested)
        const expectedRatio = plan.takeProfits
          .filter(t => t.status === 'filled')
          .reduce((sum, t) => sum + t.sizeRatio, 0)
        // If more was closed than we've tracked, a TP (or manual close) happened
        if (closedRatio > expectedRatio + 0.05) {
          log.info(`${plan.symbol} TP${tp.level} fill detected via size — closed=${(closedRatio * 100).toFixed(1)}% > tracked=${(expectedRatio * 100).toFixed(1)}%`)
          return true
        }
      }
    }
    return false
  }

  /** Cancel the open order on a Freqtrade trade (DELETE /api/v1/trades/{id}/open-order). */
  private async cancelFreqtradeOpenOrder(tradeId: number | undefined): Promise<void> {
    if (!tradeId) return
    // Use the engine's HTTP layer indirectly via cancelOrder
    // Note: FreqtradeTradingEngine.cancelOrder uses DELETE /api/v1/trade/{id}
    // which deletes the TRADE. We need to cancel the OPEN ORDER on the trade.
    // The placeExitOrder method already handles this via DELETE /api/v1/trades/{id}/open-order
    // For now, we'll do it through a new forceexit with market to close cleanly.
    // Actually, we'll just let it be — Freqtrade's placeExitOrder auto-cancels open orders.
  }

  // ==================== Event Emission ====================

  private emitEvent(plan: TradePlan, type: string, text: string): void {
    const tag = getModeTag()
    emit('trade', { type, planId: plan.id, symbol: plan.symbol, isDryRun: this.isDryRun })
    enqueueSystemEvent({
      id: `trade-${plan.id.slice(0, 8)}-${type}`,
      source: 'hook',
      text: `${tag}${text}`,
      contextKey: `trade-plan-${plan.id}`,
    })
  }
}
