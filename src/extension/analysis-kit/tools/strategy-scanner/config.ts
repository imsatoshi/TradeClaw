/**
 * Strategy parameter loader — reads from data/config/strategy-params.json
 * with a 60-second in-memory cache. Falls back to empty object (strategies
 * use hardcoded defaults) if the file is missing or malformed.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const CONFIG_PATH = resolve('data/config/strategy-params.json')

let cachedConfig: Record<string, Record<string, number>> | null = null
let lastLoadMs = 0
const RELOAD_INTERVAL = 60_000 // re-read from disk at most once per minute

export async function getStrategyParams(): Promise<Record<string, Record<string, number>>> {
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
