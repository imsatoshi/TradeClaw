/**
 * Strategy parameter loader — reads from data/config/strategy-params.json
 * with a 60-second in-memory cache. Falls back to empty object (strategies
 * use hardcoded defaults) if the file is missing or malformed.
 *
 * Supports per-symbol overrides via a `symbolOverrides` section:
 *
 *   {
 *     "ema_trend": { "slMultiplier": 1.5, ... },          // global defaults
 *     "symbolOverrides": {
 *       "ENSO/USDT": {
 *         "ema_trend": { "slMultiplier": 2.5, "tpMultiplier": 1.5 }
 *       }
 *     }
 *   }
 *
 * `getStrategyParamsFor(strategy, symbol)` merges global + symbol overrides.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const CONFIG_PATH = resolve('data/config/strategy-params.json')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedConfig: Record<string, any> | null = null
let lastLoadMs = 0
const RELOAD_INTERVAL = 60_000 // re-read from disk at most once per minute

/**
 * Load the full raw config (cached, re-reads at most once per minute).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getStrategyParams(): Promise<Record<string, any>> {
  if (cachedConfig && Date.now() - lastLoadMs < RELOAD_INTERVAL) return cachedConfig
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8')
    cachedConfig = JSON.parse(raw)
    lastLoadMs = Date.now()
  } catch {
    cachedConfig = {} // file missing or malformed → use defaults
  }
  return cachedConfig!
}

/**
 * Get merged params for a specific strategy + symbol.
 *
 * Resolution order (later wins):
 *   1. Global strategy defaults:        config[strategyName]
 *   2. Per-symbol strategy overrides:   config.symbolOverrides[symbol][strategyName]
 *
 * Only SL/TP multipliers (and any other numeric params) are merged.
 * This means you can optimize per-symbol without touching global defaults.
 */
export async function getStrategyParamsFor(
  strategyName: string,
  symbol: string,
): Promise<Record<string, number>> {
  const config = await getStrategyParams()

  const globalParams: Record<string, number> = config[strategyName] ?? {}
  const symbolOverrides: Record<string, number> =
    config.symbolOverrides?.[symbol]?.[strategyName] ?? {}

  return { ...globalParams, ...symbolOverrides }
}
