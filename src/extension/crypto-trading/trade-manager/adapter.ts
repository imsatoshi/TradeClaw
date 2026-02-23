/**
 * TradePlan AI tools — exposed to the AI agent.
 *
 * - cryptoCreateTradePlan: Create a multi-TP/SL trade plan
 * - cryptoGetTradePlans: Query active plans (with live P&L)
 * - cryptoUpdateTradePlan: Dynamically adjust TP/SL/trailing
 * - cryptoCancelTradePlan: Cancel a plan
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { TradeManager } from './TradeManager.js'

export function createTradePlanTools(manager: TradeManager) {
  return {
    cryptoCreateTradePlan: tool({
      description: `Create a trade plan with multi-level take-profits and stop-loss.

The TradeManager will automatically manage order execution:
- Places TP orders sequentially (Freqtrade allows only 1 open order per trade)
- When TP1 fills, automatically places TP2, etc.
- Stop-loss is managed separately via direct exchange (STOP_MARKET) if available
- Auto-breakeven: after TP1 fills, SL auto-moves to entry price (enabled by default)
- Trailing stop: optional — SL follows price at a fixed distance as it moves favorably
- All state changes + live P&L are reported in the next heartbeat

IMPORTANT: The entry order must already be placed (via cryptoPlaceOrder + commit + push).
The plan will detect the open trade by symbol and direction, then begin managing exits.

Example: 2-level TP plan with trailing stop
- TP1: close 50% at $9.00
- TP2: close 50% at $10.00
- SL: $7.50
- Auto-breakeven: ON (SL moves to $8.00 entry after TP1 fills)
- Trailing: 1.5% (SL follows price, keeping 1.5% distance)`,
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair, e.g. "BTC/USDT"'),
        direction: z.enum(['long', 'short']),
        takeProfits: z.array(z.object({
          price: z.number().describe('Target price for this TP level'),
          sizeRatio: z.number().min(0).max(1).describe('Portion to close (0-1), all levels should sum to 1.0'),
        })).min(1).max(5).describe('Take-profit levels (1-5), ordered by price'),
        stopLossPrice: z.number().describe('Stop-loss price'),
        reason: z.string().optional().describe('Trade rationale'),
        autoBreakeven: z.boolean().optional().describe('Auto-move SL to entry price after TP1 fills (default: true)'),
        trailingStop: z.object({
          distance: z.number().positive().describe('Trailing distance'),
          type: z.enum(['fixed', 'percent']).describe('"fixed" = absolute $ distance, "percent" = % of price'),
        }).optional().describe('Trailing stop config. SL follows price at this distance. Omit for no trailing.'),
      }),
      execute: async ({ symbol, direction, takeProfits, stopLossPrice, reason, autoBreakeven, trailingStop }) => {
        // Validate sizeRatio sum
        const ratioSum = takeProfits.reduce((s, tp) => s + tp.sizeRatio, 0)
        if (Math.abs(ratioSum - 1.0) > 0.01) {
          return { success: false, error: `Take-profit sizeRatio sum is ${ratioSum.toFixed(2)}, must equal 1.0` }
        }

        const plan = await manager.addPlan({
          symbol,
          direction,
          takeProfits,
          stopLossPrice,
          reason,
          autoBreakeven,
          trailingStop,
        })

        const features: string[] = []
        if (plan.autoBreakeven) features.push('auto-breakeven after TP1')
        if (plan.trailingStop) features.push(`trailing ${plan.trailingStop.type === 'percent' ? plan.trailingStop.distance + '%' : '$' + plan.trailingStop.distance}`)

        return {
          success: true,
          planId: plan.id,
          symbol: plan.symbol,
          direction: plan.direction,
          takeProfits: plan.takeProfits.map(tp => ({
            level: tp.level,
            price: tp.price,
            sizeRatio: tp.sizeRatio,
          })),
          stopLoss: plan.stopLoss.price,
          features: features.length > 0 ? features : undefined,
          status: plan.status,
          message: `Trade plan created. TradeManager will auto-manage TP/SL orders once the entry fills.${features.length > 0 ? ' Features: ' + features.join(', ') + '.' : ''}`,
        }
      },
    }),

    cryptoGetTradePlans: tool({
      description: 'Query active trade plans managed by TradeManager. Shows TP/SL status and live P&L for each plan.',
      inputSchema: z.object({
        symbol: z.string().optional().describe('Filter by symbol, or omit for all active plans'),
      }),
      execute: async ({ symbol }) => {
        const plans = symbol
          ? manager.getPlansBySymbol(symbol)
          : manager.getActivePlans()

        if (plans.length === 0) {
          return { plans: [], message: symbol ? `No active plans for ${symbol}.` : 'No active trade plans.' }
        }

        return {
          plans: plans.map(p => {
            const pnl = manager.getPnL(p.id)
            return {
              id: p.id,
              symbol: p.symbol,
              direction: p.direction,
              status: p.status,
              entryPrice: p.entryPrice,
              positionSize: p.positionSize,
              leverage: p.leverage,
              takeProfits: p.takeProfits.map(tp => ({
                level: tp.level,
                price: tp.price,
                sizeRatio: tp.sizeRatio,
                status: tp.status,
                filledPrice: tp.filledPrice,
              })),
              stopLoss: {
                price: p.stopLoss.price,
                status: p.stopLoss.status,
              },
              pnl: pnl ? {
                currentPrice: pnl.currentPrice,
                unrealizedPnl: Number(pnl.unrealizedPnl.toFixed(2)),
                unrealizedPnlPct: Number(pnl.unrealizedPnlPct.toFixed(2)),
                realizedPnl: Number(pnl.realizedPnl.toFixed(2)),
                riskRewardRatio: pnl.riskRewardRatio != null ? Number(pnl.riskRewardRatio.toFixed(2)) : null,
                maxDrawdown: Number(pnl.maxDrawdown.toFixed(2)),
              } : undefined,
              autoBreakeven: p.autoBreakeven,
              trailingStop: p.trailingStop,
              reason: p.reason,
              createdAt: p.createdAt,
            }
          }),
        }
      },
    }),

    cryptoUpdateTradePlan: tool({
      description: `Dynamically update an active trade plan's TP levels, SL price, and/or auto-SL features.

Use this to adapt to changing market conditions:
- Tighten SL to protect profits (e.g. move SL to breakeven after TP1 fills)
- Adjust TP targets based on new resistance/support levels
- Change TP ratios (e.g. take more profit at TP1 if momentum weakening)
- Enable/disable trailing stop or change trailing distance
- Enable/disable auto-breakeven

TradeManager will automatically cancel old orders and place new ones.
Already-filled TP levels are preserved — only pending levels are updated.`,
      inputSchema: z.object({
        planId: z.string().describe('The plan ID to update'),
        takeProfits: z.array(z.object({
          price: z.number().describe('New target price'),
          sizeRatio: z.number().min(0).max(1).describe('Portion of REMAINING position (0-1), should sum to 1.0'),
        })).optional().describe('New TP levels for remaining position. Omit to keep current TPs.'),
        stopLossPrice: z.number().optional().describe('New stop-loss price. Omit to keep current SL.'),
        autoBreakeven: z.boolean().optional().describe('Enable/disable auto-breakeven. Omit to keep current.'),
        trailingStop: z.object({
          distance: z.number().positive().describe('Trailing distance'),
          type: z.enum(['fixed', 'percent']).describe('"fixed" = absolute $ distance, "percent" = % of price'),
        }).nullable().optional().describe('Set trailing stop config, or null to disable. Omit to keep current.'),
      }),
      execute: async ({ planId, takeProfits, stopLossPrice, autoBreakeven, trailingStop }) => {
        if (takeProfits) {
          const ratioSum = takeProfits.reduce((s, tp) => s + tp.sizeRatio, 0)
          if (Math.abs(ratioSum - 1.0) > 0.01) {
            return { success: false, error: `Take-profit sizeRatio sum is ${ratioSum.toFixed(2)}, must equal 1.0` }
          }
        }

        const result = await manager.updatePlan(planId, {
          takeProfits,
          stopLossPrice,
          autoBreakeven,
          trailingStop,
        })

        if (!result.success) return result

        return {
          success: true,
          planId,
          message: 'Trade plan updated. TradeManager will re-place orders automatically.',
          currentPlan: result.plan ? {
            takeProfits: result.plan.takeProfits.map(tp => ({
              level: tp.level, price: tp.price, sizeRatio: tp.sizeRatio, status: tp.status,
            })),
            stopLoss: { price: result.plan.stopLoss.price, status: result.plan.stopLoss.status },
            autoBreakeven: result.plan.autoBreakeven,
            trailingStop: result.plan.trailingStop,
          } : undefined,
        }
      },
    }),

    cryptoCancelTradePlan: tool({
      description: 'Cancel an active trade plan. Cancels any open TP/SL orders and stops auto-management.',
      inputSchema: z.object({
        planId: z.string().describe('The plan ID to cancel'),
      }),
      execute: async ({ planId }) => {
        return await manager.cancelPlan(planId)
      },
    }),
  }
}
