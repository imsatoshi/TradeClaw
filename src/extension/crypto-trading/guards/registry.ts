/**
 * Guard Registry — config-driven guard instantiation.
 *
 * Reads data/config/guards.json and creates guards from the registry.
 * Falls back to hardcoded defaults if config file is missing.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Guard } from './guard-pipeline.js'
import {
  MaxPositionSizeGuard,
  CooldownGuard,
  MaxOpenTradesGuard,
  MinBalanceGuard,
} from './guard-pipeline.js'
import { EmotionGuard, type EmotionGetter } from './emotion-guard.js'

const GUARDS_CONFIG_PATH = resolve('data/config/guards.json')

interface GuardEntry {
  name: string
  enabled: boolean
  params: Record<string, unknown>
}

interface GuardsConfig {
  guards: GuardEntry[]
}

type GuardFactory = (params: Record<string, unknown>, deps: GuardDeps) => Guard

interface GuardDeps {
  emotionGetter?: EmotionGetter
}

const GUARD_REGISTRY: Record<string, GuardFactory> = {
  MaxPositionSize: (p) => new MaxPositionSizeGuard({
    maxPercentOfEquity: typeof p.maxPercentOfEquity === 'number' ? p.maxPercentOfEquity : undefined,
  }),
  Cooldown: (p) => new CooldownGuard({
    minIntervalMs: typeof p.minIntervalMs === 'number' ? p.minIntervalMs : undefined,
  }),
  MaxOpenTrades: (p) => new MaxOpenTradesGuard({
    maxOpenTrades: typeof p.maxOpenTrades === 'number' ? p.maxOpenTrades : undefined,
  }),
  MinBalance: (p) => new MinBalanceGuard({
    minBalanceRatio: typeof p.minBalanceRatio === 'number' ? p.minBalanceRatio : undefined,
  }),
  Emotion: (_p, deps) => {
    if (!deps.emotionGetter) {
      // Return a pass-through guard if no emotion getter available
      return { name: 'EmotionGuard (disabled)', check: () => ({ allowed: true }) }
    }
    return new EmotionGuard(deps.emotionGetter)
  },
}

function loadGuardsConfig(): GuardsConfig | null {
  try {
    const raw = readFileSync(GUARDS_CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as GuardsConfig
  } catch {
    return null
  }
}

/**
 * Create guards from config file. Falls back to createDefaultGuards behavior
 * if config file is missing or invalid.
 */
export function createGuardsFromConfig(deps: GuardDeps = {}): Guard[] {
  const config = loadGuardsConfig()
  if (!config?.guards) {
    // Fallback: hardcoded defaults
    const guards: Guard[] = [
      new MaxPositionSizeGuard(),
      new CooldownGuard(),
      new MaxOpenTradesGuard(),
      new MinBalanceGuard(),
    ]
    if (deps.emotionGetter) {
      guards.push(new EmotionGuard(deps.emotionGetter))
    }
    return guards
  }

  const guards: Guard[] = []
  for (const entry of config.guards) {
    if (!entry.enabled) continue

    const factory = GUARD_REGISTRY[entry.name]
    if (!factory) {
      console.warn(`guard-registry: unknown guard "${entry.name}", skipping`)
      continue
    }

    guards.push(factory(entry.params ?? {}, deps))
  }

  console.log(`guard-registry: loaded ${guards.length} guard(s) from config: ${guards.map(g => g.name).join(', ')}`)
  return guards
}
