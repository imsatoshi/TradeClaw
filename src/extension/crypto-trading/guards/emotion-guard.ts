/**
 * EmotionGuard — couples Brain emotion state to trading risk.
 *
 * Reads the current emotion from Brain and adjusts position sizing:
 *   confident / neutral → 100% (normal)
 *   cautious            → 50%  (half size)
 *   scared / fearful    → 25%  (quarter size)
 *   angry / tilted      → 0%   (blocked)
 *
 * The guard modifies usd_size in the operation params when reducing,
 * and blocks entirely when the multiplier is 0.
 */

import type { Guard, GuardContext, GuardResult } from './guard-pipeline.js'

export type EmotionGetter = () => string

/**
 * Multiplier for each recognized emotion keyword.
 * v5: More aggressive reduction for negative emotions.
 * Rationale: emotional trading degrades win-rate, not just sizing.
 * cautious → assume win-rate drops ~10% → Kelly says ~35% of normal size
 * scared → assume win-rate drops ~20% → Kelly says ~15% of normal size
 */
const EMOTION_MULTIPLIER: Record<string, number> = {
  confident: 1.0,
  neutral: 1.0,
  calm: 1.0,
  focused: 1.0,
  cautious: 0.35,   // was 0.5 — win-rate degradation model
  anxious: 0.35,     // was 0.5
  uncertain: 0.35,   // was 0.5
  scared: 0.15,      // was 0.25
  fearful: 0.15,     // was 0.25
  angry: 0,
  tilted: 0,
  frustrated: 0,
  revenge: 0,
  fomo: 0.15,        // was 0.25 — FOMO is high-risk emotional state
  greedy: 0.35,      // was 0.5
}

function matchEmotion(emotionStr: string): { keyword: string; multiplier: number } {
  const lower = emotionStr.toLowerCase()
  for (const [keyword, multiplier] of Object.entries(EMOTION_MULTIPLIER)) {
    if (lower.includes(keyword)) {
      return { keyword, multiplier }
    }
  }
  // Unknown emotion → allow but log
  return { keyword: lower, multiplier: 1.0 }
}

export class EmotionGuard implements Guard {
  readonly name = 'EmotionGuard'
  private getEmotion: EmotionGetter

  constructor(getEmotion: EmotionGetter) {
    this.getEmotion = getEmotion
  }

  check(ctx: GuardContext): GuardResult {
    if (ctx.operation.action !== 'placeOrder') return { allowed: true }
    if (ctx.operation.params.reduceOnly) return { allowed: true }

    const emotionStr = this.getEmotion()
    const { keyword, multiplier } = matchEmotion(emotionStr)

    if (multiplier === 0) {
      return {
        allowed: false,
        reason: `Emotion "${keyword}" detected — trading suspended until emotion improves`,
      }
    }

    if (multiplier < 1.0) {
      // Reduce position size
      const params = ctx.operation.params as Record<string, unknown>
      if (typeof params.usd_size === 'number') {
        params.usd_size = params.usd_size * multiplier
      }
      if (typeof params.size === 'number') {
        params.size = params.size * multiplier
      }
      // Allow but with reduced size — the caller sees the modified params
    }

    return { allowed: true }
  }
}
