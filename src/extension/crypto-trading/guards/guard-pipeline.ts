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

import type { Operation } from '../wallet/types.js';
import type { CryptoPosition, CryptoAccountInfo } from '../interfaces.js';
import { EmotionGuard, type EmotionGetter } from './emotion-guard.js';
import { AccountDrawdownGuard } from './account-drawdown-guard.js';

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
 * Block if the projected position notional value exceeds a percentage of account equity.
 * Default: 40% of equity.
 */
export class MaxPositionSizeGuard implements Guard {
  readonly name = 'MaxPositionSizeGuard';
  private maxPercent: number;

  constructor(opts: { maxPercentOfEquity?: number } = {}) {
    this.maxPercent = opts.maxPercentOfEquity ?? 40;
  }

  check(ctx: GuardContext): GuardResult {
    if (ctx.operation.action !== 'placeOrder') return { allowed: true };
    if (ctx.operation.params.reduceOnly) return { allowed: true };

    const { positions, account, operation } = ctx;
    const symbol = operation.params.symbol as string;

    // Estimate the USD value of this order
    const usdSize = operation.params.usd_size as number | undefined;
    const size = operation.params.size as number | undefined;
    const price = operation.params.price as number | undefined;

    let addedValue = 0;
    if (usdSize) {
      addedValue = usdSize;
    } else if (size && price) {
      addedValue = size * price;
    } else if (size) {
      // Try to estimate from existing position's mark price
      const existing = positions.find(p => p.symbol === symbol);
      if (existing) {
        addedValue = size * existing.markPrice;
      }
    }

    if (addedValue === 0 || account.equity <= 0) return { allowed: true };

    // Include existing position value for the same symbol
    const existing = positions.find(p => p.symbol === symbol);
    const currentValue = existing?.positionValue ?? 0;
    const projectedValue = currentValue + addedValue;
    const percent = (projectedValue / account.equity) * 100;

    if (percent > this.maxPercent) {
      return {
        allowed: false,
        reason: `Position for ${symbol} would be ${percent.toFixed(1)}% of equity ($${account.equity.toFixed(2)}), exceeds ${this.maxPercent}% limit`,
      };
    }

    return { allowed: true };
  }
}

/**
 * Block if the same symbol was traded within N milliseconds.
 * Default: 60 seconds.
 */
export class CooldownGuard implements Guard {
  readonly name = 'CooldownGuard';
  private minIntervalMs: number;
  private lastTradeTime = new Map<string, number>();

  constructor(opts: { minIntervalMs?: number } = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 60_000;
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

    // Record the trade time (even before execution — we gate on attempt)
    this.lastTradeTime.set(symbol, now);
    return { allowed: true };
  }
}

/**
 * Block if already at the max number of concurrent open positions.
 * Default: 5 (matches CRYPTO_MAX_OPEN_TRADES).
 */
export class MaxOpenTradesGuard implements Guard {
  readonly name = 'MaxOpenTradesGuard';
  private maxOpenTrades: number;

  constructor(opts: { maxOpenTrades?: number } = {}) {
    this.maxOpenTrades = opts.maxOpenTrades ?? 5;
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
} = {}): Guard[] {
  const guards: Guard[] = [
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
