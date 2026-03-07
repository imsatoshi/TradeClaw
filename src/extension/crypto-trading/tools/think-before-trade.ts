/**
 * thinkBeforeTrade — mandatory pre-trade reasoning gate.
 *
 * AI must call this tool BEFORE proposing any trade. It enforces:
 * 1. Structured reasoning (edge, risk, confidence)
 * 2. Minimum confidence threshold (blocks < 60)
 * 3. Checklist verification
 * 4. Persistent reasoning log for review
 * 5. Execution mode routing (auto / confirm / blocked)
 */

import { tool } from 'ai'
import { z } from 'zod'
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const REASONING_LOG_PATH = 'data/trade-reasoning/reasoning.jsonl'
const AUTO_TRADE_CONFIG_PATH = resolve('data/config/auto-trade.json')
const MIN_CONFIDENCE = 60

export interface AutoTradeConfig {
  enabled: boolean
  minConfidence: number
  minGrade: string
  maxAutoUsdSize: number
  notifyOnAuto: boolean
}

const DEFAULT_AUTO_CONFIG: AutoTradeConfig = {
  enabled: false,
  minConfidence: 80,
  minGrade: 'A',
  maxAutoUsdSize: 500,
  notifyOnAuto: true,
}

async function loadAutoTradeConfig(): Promise<AutoTradeConfig> {
  try {
    const raw = await readFile(AUTO_TRADE_CONFIG_PATH, 'utf-8')
    return { ...DEFAULT_AUTO_CONFIG, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_AUTO_CONFIG
  }
}

export interface ThinkResult {
  approved: boolean
  /** 'auto' = execute without user confirmation, 'confirm' = send to Telegram buttons, 'blocked' = do not trade */
  executionMode: 'auto' | 'confirm' | 'blocked'
  reason: string
  confidence: number
  symbol: string
  direction: string
  /** Max USD size for auto-execution (only relevant when mode === 'auto') */
  maxAutoUsdSize?: number
}

export function createThinkBeforeTradeTools() {
  return {
    thinkBeforeTrade: tool({
      description: `
MANDATORY pre-trade reasoning gate. You MUST call this BEFORE proposeTradeWithButtons or any order placement.

This tool forces structured thinking and blocks low-quality trades:
- Confidence < 60 → BLOCKED (not enough conviction)
- Any checklist item false → BLOCKED (incomplete preparation)
- Grade C setups without AI override reason → BLOCKED

Returns an executionMode:
- "auto" → High confidence + Grade A + auto-trade enabled → skip proposeTradeWithButtons, execute directly
- "confirm" → Medium confidence → use proposeTradeWithButtons for Telegram confirmation
- "blocked" → Trade rejected

If executionMode is "auto", proceed directly to calculatePositionSize → createTradePlan → cryptoPlaceOrder.
If executionMode is "confirm", proceed to proposeTradeWithButtons as usual.
If executionMode is "blocked", do NOT proceed with the trade.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair, e.g. BTC/USDT'),
        direction: z.enum(['long', 'short']).describe('Trade direction'),
        edge: z.string().describe('What is your edge? Why will this trade work? Be specific with indicator values.'),
        risk: z.string().describe('What could go wrong? What would invalidate this setup?'),
        confidence: z.number().min(0).max(100).describe('Your conviction level 0-100. Be honest — 60 is the minimum to proceed.'),
        scannerGrade: z.enum(['A', 'B', 'C', 'N/A']).describe('Scanner grade from strategyScan'),
        aiOverride: z.string().optional().describe('If you are overriding the scanner grade (upgrading B→A or downgrading A→B), explain why.'),
        checklist: z.object({
          positionSizeOk: z.boolean().describe('Have you verified position size is within risk limits?'),
          newsChecked: z.boolean().describe('Have you checked recent news for this symbol?'),
          noRecentLoss: z.boolean().describe('No loss on this same symbol in the last 2 hours?'),
        }),
      }),
      execute: async ({ symbol, direction, edge, risk, confidence, scannerGrade, aiOverride, checklist }) => {
        const reasons: string[] = []

        // Check confidence threshold
        if (confidence < MIN_CONFIDENCE) {
          reasons.push(`confidence ${confidence} < ${MIN_CONFIDENCE} minimum`)
        }

        // Check checklist
        if (!checklist.positionSizeOk) {
          reasons.push('position size not verified')
        }
        if (!checklist.newsChecked) {
          reasons.push('news not checked')
        }
        if (!checklist.noRecentLoss) {
          reasons.push(`recent loss on ${symbol} — cooldown required`)
        }

        // Grade C without override
        if (scannerGrade === 'C' && !aiOverride) {
          reasons.push('Grade C setup without AI override justification')
        }

        const approved = reasons.length === 0

        // Determine execution mode
        let executionMode: 'auto' | 'confirm' | 'blocked' = 'blocked'
        let maxAutoUsdSize: number | undefined

        if (approved) {
          const autoConfig = await loadAutoTradeConfig()

          const gradeRank: Record<string, number> = { 'A': 3, 'B': 2, 'C': 1, 'N/A': 0 }
          const minGradeRank = gradeRank[autoConfig.minGrade] ?? 3
          const actualGradeRank = gradeRank[scannerGrade] ?? 0

          if (
            autoConfig.enabled &&
            confidence >= autoConfig.minConfidence &&
            actualGradeRank >= minGradeRank
          ) {
            executionMode = 'auto'
            maxAutoUsdSize = autoConfig.maxAutoUsdSize
          } else {
            executionMode = 'confirm'
          }
        }

        const result: ThinkResult = {
          approved,
          executionMode,
          reason: !approved
            ? `BLOCKED: ${reasons.join('; ')}`
            : executionMode === 'auto'
              ? `AUTO-EXECUTE: ${symbol} ${direction.toUpperCase()}, confidence ${confidence}, grade ${scannerGrade} (max $${maxAutoUsdSize})`
              : `CONFIRM: ${symbol} ${direction.toUpperCase()}, confidence ${confidence}, grade ${scannerGrade} — send to Telegram`,
          confidence,
          symbol,
          direction,
          ...(executionMode === 'auto' ? { maxAutoUsdSize } : {}),
        }

        // Log reasoning (always, both approved and blocked)
        const entry = {
          ts: Date.now(),
          symbol,
          direction,
          edge,
          risk,
          confidence,
          scannerGrade,
          aiOverride: aiOverride ?? null,
          checklist,
          approved,
          executionMode,
          blockReasons: reasons.length > 0 ? reasons : null,
        }

        try {
          await mkdir(dirname(REASONING_LOG_PATH), { recursive: true })
          await appendFile(REASONING_LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8')
        } catch {
          // Non-fatal: logging failure should not block trade decision
        }

        return result
      },
    }),
  }
}
