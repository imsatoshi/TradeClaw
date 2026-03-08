/**
 * AccountDrawdownGuard — Block new trades if daily equity drawdown exceeds threshold.
 *
 * Tracks a daily high watermark (reset at midnight in configured timezone, default UTC+8) and blocks non-reduceOnly
 * placeOrder operations when current equity drops below watermark * (1 - maxDailyPercent/100).
 */

import type { Guard, GuardContext, GuardResult } from './guard-pipeline.js';

export class AccountDrawdownGuard implements Guard {
  readonly name = 'AccountDrawdownGuard';

  private maxDailyPercent: number;
  private tzOffsetHours: number;
  private highWatermark = 0;
  private watermarkDate = ''; // YYYY-MM-DD in local TZ

  constructor(opts: { maxDailyPercent?: number; timezoneOffsetHours?: number } = {}) {
    this.maxDailyPercent = opts.maxDailyPercent ?? 5;
    this.tzOffsetHours = opts.timezoneOffsetHours ?? 8; // default UTC+8
  }

  /** Get today's date string in configured timezone. */
  private todayLocal(): string {
    const now = new Date();
    const localMs = now.getTime() + this.tzOffsetHours * 3600_000;
    return new Date(localMs).toISOString().slice(0, 10);
  }

  check(ctx: GuardContext): GuardResult {
    if (ctx.operation.action !== 'placeOrder') return { allowed: true };
    if (ctx.operation.params.reduceOnly) return { allowed: true };

    const equity = ctx.account.equity;
    if (equity <= 0) return { allowed: true };

    const today = this.todayLocal();

    // Reset watermark on new UTC day
    if (today !== this.watermarkDate) {
      this.highWatermark = equity;
      this.watermarkDate = today;
    }

    // Update high watermark if equity has risen
    if (equity > this.highWatermark) {
      this.highWatermark = equity;
    }

    const threshold = this.highWatermark * (1 - this.maxDailyPercent / 100);
    if (equity < threshold) {
      const drawdownPct = ((this.highWatermark - equity) / this.highWatermark * 100).toFixed(2);
      return {
        allowed: false,
        reason: `Daily drawdown ${drawdownPct}% exceeds ${this.maxDailyPercent}% limit (equity $${equity.toFixed(2)}, watermark $${this.highWatermark.toFixed(2)}). No new positions until recovery or next day (UTC+${this.tzOffsetHours}).`,
      };
    }

    return { allowed: true };
  }
}
