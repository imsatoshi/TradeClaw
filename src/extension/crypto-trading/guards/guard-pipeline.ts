/**
 * Guard Pipeline — Pre-execution safety checks for crypto trading operations
 *
 * CODE-level risk enforcement that cannot be bypassed by AI prompt manipulation.
 * Each guard inspects a GuardContext and returns { allowed, reason } to block or allow.
 *
 * Guards implemented:
 * - MaxPositionSizeGuard:  Block if position notional > N% of equity
 * - CooldownGuard:         Block if same symbol was traded within N seconds
 * - MaxOpenTradesGuard:    Block if already at max concurrent positions
 * - MinBalanceGuard:       Block if available balance < N% of equity after trade
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Operation } from '../wallet/types.js';
import type { CryptoPosition, CryptoAccountInfo } from '../interfaces.js';
import { CRYPTO_DEFAULT_LEVERAGE } from '../interfaces.js';
import { EmotionGuard, type EmotionGetter } from './emotion-guard.js';
import { AccountDrawdownGuard } from './account-drawdown-guard.js';

const COOLDOWN_STATE_FILE = resolve('data/state/cooldown.json');

// ==================== Types ====================

export interface GuardContext {
  readonly operation: Operation;
  readonly positions: readonly CryptoPosition[];
  readonly account: Readonly<CryptoAccountInfo>;
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

export interface Guard {
  readonly name: string;
  check(ctx: GuardContext): GuardResult | Promise<GuardResult>;
}

// ==================== Pipeline runner ====================

/**
 * Run all guards sequentially. Returns the first failing guard's result,
 * or { allowed: true } if all guards pass.
 */
export async function runGuardPipeline(
  guards: Guard[],
  context: GuardContext,
): Promise<GuardResult & { guardName?: string }> {
  for (const guard of guards) {
    try {
      const result = await guard.check(context);
      if (!result.allowed) {
        return { allowed: false, reason: result.reason, guardName: guard.name };
      }
    } catch (err) {
      // Guard threw an exception — treat as blocked (fail-closed)
      return {
        allowed: false,
        reason: `Guard threw exception: ${err instanceof Error ? err.message : String(err)}`,
        guardName: guard.name,
      };
    }
  }
  return { allowed: true };
}

// ==================== Guard implementations ====================

/**
 * Block if the projected position MARGIN usage exceeds a percentage of account equity.
 * Default: 25% of equity.
 *
 * Margin = notional / leverage. With 10x leverage, a $1000 notional position
 * only uses $100 of margin, so it's the margin that matters for risk sizing.
 */
export class MaxPositionSizeGuard implements Guard {
  readonly name = 'MaxPositionSizeGuard';
  private maxPercent: number;

  constructor(opts: { maxPercentOfEquity?: number } = {}) {
    this.maxPercent = opts.maxPercentOfEquity ?? 25;
  }

  check(ctx: GuardContext): GuardResult {
    if (ctx.operation.action !== 'placeOrder') return { allowed: true };
    if (ctx.operation.params.reduceOnly) return { allowed: true };

    const { positions, account, operation } = ctx;
    const symbol = operation.params.symbol as string;

    // Determine leverage for this order
    const orderLeverage = (operation.params.leverage as number | undefined) ?? CRYPTO_DEFAULT_LEVERAGE;
    const leverage = Math.max(orderLeverage, 1); // floor at 1x

    // Estimate the USD notional value of this order
    const usdSize = operation.params.usd_size as number | undefined;
    const size = operation.params.size as number | undefined;
    const price = operation.params.price as number | undefined;

    let addedNotional = 0;
    if (usdSize) {
      addedNotional = usdSize;
    } else if (size && price) {
      addedNotional = size * price;
    } else if (size) {
      // Try to estimate from existing position's mark price
      const existing = positions.find(p => p.symbol === symbol);
      if (existing) {
        addedNotional = size * existing.markPrice;
      }
    }

    if (addedNotional === 0 || account.equity <= 0) return { allowed: true };

    // Convert notional to margin (margin = notional / leverage)
    const addedMargin = addedNotional / leverage;

    // Include existing position's margin for the same symbol
    const existing = positions.find(p => p.symbol === symbol);
    const currentMargin = existing ? (existing.margin || existing.positionValue / Math.max(existing.leverage, 1)) : 0;
    const projectedMargin = currentMargin + addedMargin;
    const percent = (projectedMargin / account.equity) * 100;

    if (percent > this.maxPercent) {
      return {
        allowed: false,
        reason: `Margin for ${symbol} would be ${percent.toFixed(1)}% of equity ($${account.equity.toFixed(2)}), exceeds ${this.maxPercent}% limit (notional $${(addedNotional + (existing?.positionValue ?? 0)).toFixed(0)} at ${leverage}x leverage)`,
      };
    }

    return { allowed: true };
  }
}

/**
 * Block if the same symbol was traded within N milliseconds.
 * Default: 300 seconds (5 minutes).
 */
export class CooldownGuard implements Guard {
  readonly name = 'CooldownGuard';
  private minIntervalMs: number;
  private lastTradeTime = new Map<string, number>();

  constructor(opts: { minIntervalMs?: number } = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 300_000;
    this.loadState();
  }

  /** Load persisted cooldown state from disk (survives restarts). */
  private loadState(): void {
    try {
      const raw = readFileSync(COOLDOWN_STATE_FILE, 'utf-8');
      const data = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      for (const [symbol, ts] of Object.entries(data)) {
        // Only restore entries still within the cooldown window
        if (now - ts < this.minIntervalMs) {
          this.lastTradeTime.set(symbol, ts);
        }
      }
    } catch {
      // No state file or invalid — start fresh
    }
  }

  /** Persist current cooldown state to disk. */
  private saveState(): void {
    try {
      const dir = dirname(COOLDOWN_STATE_FILE);
      mkdirSync(dir, { recursive: true });
      const data: Record<string, number> = {};
      for (const [symbol, ts] of this.lastTradeTime) {
        data[symbol] = ts;
      }
      writeFileSync(COOLDOWN_STATE_FILE, JSON.stringify(data), 'utf-8');
    } catch {
      // Best-effort — don't crash if write fails
    }
  }

  check(ctx: GuardContext): GuardResult {
    if (ctx.operation.action !== 'placeOrder') return { allowed: true };

    const symbol = ctx.operation.params.symbol as string;
    const now = Date.now();
    const lastTime = this.lastTradeTime.get(symbol);

    if (lastTime != null) {
      const elapsed = now - lastTime;
      if (elapsed < this.minIntervalMs) {
        const remaining = Math.ceil((this.minIntervalMs - elapsed) / 1000);
        return {
          allowed: false,
          reason: `Cooldown active for ${symbol}: ${remaining}s remaining`,
        };
      }
    }

    // Don't record here — call recordTrade() after successful execution
    return { allowed: true };
  }

  /** Record a successful trade. Call AFTER order execution succeeds. */
  recordTrade(symbol: string): void {
    this.lastTradeTime.set(symbol, Date.now());
    this.saveState();
  }
}

/**
 * Block if already at the max number of concurrent open positions.
 * Default: 3.
 */
export class MaxOpenTradesGuard implements Guard {
  readonly name = 'MaxOpenTradesGuard';
  private maxOpenTrades: number;

  constructor(opts: { maxOpenTrades?: number } = {}) {
    this.maxOpenTrades = opts.maxOpenTrades ?? 3;
  }

  check(ctx: GuardContext): GuardResult {
    if (ctx.operation.action !== 'placeOrder') return { allowed: true };
    if (ctx.operation.params.reduceOnly) return { allowed: true };

    if (ctx.positions.length >= this.maxOpenTrades) {
      return {
        allowed: false,
        reason: `Max ${this.maxOpenTrades} concurrent positions reached (current: ${ctx.positions.length}). Close a position first.`,
      };
    }

    return { allowed: true };
  }
}

/**
 * Block if available balance would drop below a percentage of equity after this trade.
 * Default: 30% of equity.
 */
export class MinBalanceGuard implements Guard {
  readonly name = 'MinBalanceGuard';
  private minBalanceRatio: number;

  constructor(opts: { minBalanceRatio?: number } = {}) {
    this.minBalanceRatio = opts.minBalanceRatio ?? 0.3;
  }

  check(ctx: GuardContext): GuardResult {
    if (ctx.operation.action !== 'placeOrder') return { allowed: true };
    if (ctx.operation.params.reduceOnly) return { allowed: true };

    const { account } = ctx;
    if (account.equity <= 0) return { allowed: true };

    if (account.balance < account.equity * this.minBalanceRatio) {
      return {
        allowed: false,
        reason: `Available balance ($${account.balance.toFixed(2)}) below ${(this.minBalanceRatio * 100).toFixed(0)}% of equity ($${account.equity.toFixed(2)}). No new positions.`,
      };
    }

    return { allowed: true };
  }
}

// ==================== Rate Limit Guard ====================

/**
 * Sliding-window rate limiter: blocks if more than `maxOrders` order
 * placements occur within `windowMs` milliseconds.
 * Default: max 10 orders per 60 seconds.
 */
export class RateLimitGuard implements Guard {
  readonly name = 'RateLimitGuard';
  private maxOrders: number;
  private windowMs: number;
  /** Timestamps of recent order attempts (oldest first). */
  private timestamps: number[] = [];

  constructor(opts: { maxOrders?: number; windowMs?: number } = {}) {
    this.maxOrders = opts.maxOrders ?? 10;
    this.windowMs = opts.windowMs ?? 60_000;
  }

  check(ctx: GuardContext): GuardResult {
    if (ctx.operation.action !== 'placeOrder') return { allowed: true };

    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Evict expired timestamps
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxOrders) {
      const oldestAge = now - this.timestamps[0];
      const retryIn = Math.ceil((this.windowMs - oldestAge) / 1000);
      return {
        allowed: false,
        reason: `Rate limit: ${this.maxOrders} orders in ${this.windowMs / 1000}s window reached. Retry in ~${retryIn}s.`,
      };
    }

    // Record this order timestamp
    this.timestamps.push(now);
    return { allowed: true };
  }
}

// ==================== Factory ====================

/**
 * Create the default set of guards with sensible defaults.
 * Pass overrides to customize thresholds.
 */
export function createDefaultGuards(opts: {
  maxPositionSizePercent?: number;
  cooldownMs?: number;
  maxOpenTrades?: number;
  minBalanceRatio?: number;
  emotionGetter?: EmotionGetter;
  maxDailyDrawdownPercent?: number;
  rateLimitMaxOrders?: number;
  rateLimitWindowMs?: number;
} = {}): Guard[] {
  const guards: Guard[] = [
    new RateLimitGuard({ maxOrders: opts.rateLimitMaxOrders, windowMs: opts.rateLimitWindowMs }),
    new MaxPositionSizeGuard({ maxPercentOfEquity: opts.maxPositionSizePercent }),
    new CooldownGuard({ minIntervalMs: opts.cooldownMs }),
    new MaxOpenTradesGuard({ maxOpenTrades: opts.maxOpenTrades }),
    new MinBalanceGuard({ minBalanceRatio: opts.minBalanceRatio }),
  ];
  if (opts.emotionGetter) {
    guards.push(new EmotionGuard(opts.emotionGetter));
  }
  guards.push(new AccountDrawdownGuard({ maxDailyPercent: opts.maxDailyDrawdownPercent }));
  return guards;
}
