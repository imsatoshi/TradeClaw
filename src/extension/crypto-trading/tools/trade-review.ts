/**
 * tradeReview — post-trade analysis tool.
 *
 * AI calls this after a trade plan completes (all TPs filled, SL hit, or cancelled).
 * Records structured reasoning about what worked, what didn't, and lessons learned.
 * Stored in monthly JSONL files for pattern analysis.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const REVIEWS_DIR = resolve('data/trade-reviews')

function currentMonthFile(): string {
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return resolve(REVIEWS_DIR, `${ym}.jsonl`)
}

export function createTradeReviewTools() {
  return {
    tradeReview: tool({
      description: `
Record a post-trade review after a trade plan completes, SL triggers, or you cancel a plan.

Call this tool to analyze what happened and extract lessons. Reviews are stored and
can be queried later to identify patterns in your trading.

You SHOULD call this after every completed trade — wins AND losses.
      `.trim(),
      inputSchema: z.object({
        planId: z.string().describe('The trade plan ID being reviewed'),
        symbol: z.string().describe('Trading pair, e.g. BTC/USDT'),
        direction: z.enum(['long', 'short']),
        outcome: z.enum(['win', 'loss', 'breakeven']).describe('Final outcome'),
        pnlPercent: z.number().describe('Realized PnL as percentage of entry (e.g. 2.5 for +2.5%, -1.3 for -1.3%)'),
        pnlUsd: z.number().optional().describe('Realized PnL in USD'),
        whyItWorked: z.string().describe('For wins: what was the key edge? For losses: why did it fail?'),
        whatAlmostWentWrong: z.string().describe('What risk nearly materialized? What was the closest call?'),
        keyIndicator: z.string().describe('Which indicator or signal was most important for this trade?'),
        wouldRepeat: z.boolean().describe('Would you take this exact same trade again in the same conditions?'),
        lesson: z.string().describe('1-2 sentence lesson learned from this trade'),
      }),
      execute: async ({ planId, symbol, direction, outcome, pnlPercent, pnlUsd, whyItWorked, whatAlmostWentWrong, keyIndicator, wouldRepeat, lesson }) => {
        const entry = {
          ts: Date.now(),
          planId,
          symbol,
          direction,
          outcome,
          pnlPercent,
          pnlUsd: pnlUsd ?? null,
          whyItWorked,
          whatAlmostWentWrong,
          keyIndicator,
          wouldRepeat,
          lesson,
        }

        try {
          await mkdir(REVIEWS_DIR, { recursive: true })
          await appendFile(currentMonthFile(), JSON.stringify(entry) + '\n', 'utf-8')
        } catch (err) {
          return { saved: false, error: `Failed to save review: ${err instanceof Error ? err.message : String(err)}` }
        }

        return {
          saved: true,
          message: `Review recorded for ${symbol} ${direction} (${outcome}, ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`,
        }
      },
    }),

    queryTradeReviews: tool({
      description: `
Query past trade reviews to identify patterns. Returns recent reviews filtered by criteria.
Use this to learn from past trades before making new decisions.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().optional().describe('Filter by symbol'),
        outcome: z.enum(['win', 'loss', 'breakeven']).optional().describe('Filter by outcome'),
        limit: z.number().int().min(1).max(50).optional().describe('Max reviews to return (default 10)'),
      }),
      execute: async ({ symbol, outcome, limit }) => {
        const maxResults = limit ?? 10

        // Read current and previous month files
        const now = new Date()
        const files = [
          currentMonthFile(),
          (() => {
            const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
            const ym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
            return resolve(REVIEWS_DIR, `${ym}.jsonl`)
          })(),
        ]

        const allReviews: any[] = []
        for (const file of files) {
          try {
            const raw = await readFile(file, 'utf-8')
            for (const line of raw.trim().split('\n')) {
              if (!line) continue
              try { allReviews.push(JSON.parse(line)) } catch { /* skip */ }
            }
          } catch { /* file not found */ }
        }

        // Filter
        let filtered = allReviews
        if (symbol) filtered = filtered.filter(r => r.symbol === symbol)
        if (outcome) filtered = filtered.filter(r => r.outcome === outcome)

        // Return most recent
        const results = filtered.slice(-maxResults).reverse()

        // Compute summary stats
        const wins = filtered.filter(r => r.outcome === 'win').length
        const losses = filtered.filter(r => r.outcome === 'loss').length
        const total = filtered.length
        const avgPnl = total > 0 ? filtered.reduce((s, r) => s + (r.pnlPercent ?? 0), 0) / total : 0

        return {
          reviews: results,
          stats: {
            total,
            wins,
            losses,
            winRate: total > 0 ? `${((wins / total) * 100).toFixed(1)}%` : 'N/A',
            avgPnlPercent: avgPnl.toFixed(2),
          },
        }
      },
    }),
  }
}
