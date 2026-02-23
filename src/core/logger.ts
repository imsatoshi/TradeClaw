/**
 * Minimal structured logger with global trading-mode awareness.
 *
 * Output format (one JSON line per entry):
 *   {"ts":"...","level":"info","mode":"dry-run","cat":"scanner","msg":"...","data":{...}}
 *
 * Usage:
 *   import { createLogger, setTradingMode } from './logger.js'
 *
 *   setTradingMode(true)  // call once at startup
 *
 *   const log = createLogger('scanner')
 *   log.info('scan complete', { signals: 3 })
 *   log.warn('ATR is zero for BTC/USDT')
 */

type TradingMode = 'dry-run' | 'live'

/** Global trading mode — set once at startup, read by all loggers. */
let globalMode: TradingMode | undefined

/**
 * Set the global trading mode. Call once after detecting dry-run from Freqtrade config.
 * All subsequent log entries will include a `mode` field.
 */
export function setTradingMode(isDryRun: boolean): void {
  globalMode = isDryRun ? 'dry-run' : 'live'
}

/** Get the current mode tag string (e.g. "[DRY] " or "[LIVE] "). Empty if unset. */
export function getModeTag(): string {
  if (!globalMode) return ''
  return globalMode === 'dry-run' ? '[DRY] ' : '[LIVE] '
}

/** Get the current trading mode. */
export function getTradingMode(): TradingMode | undefined {
  return globalMode
}

interface LogEntry {
  ts: string
  level: 'info' | 'warn' | 'error'
  mode?: TradingMode
  cat: string
  msg: string
  data?: unknown
}

function write(level: LogEntry['level'], cat: string, msg: string, data?: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, cat, msg }
  if (globalMode) entry.mode = globalMode
  if (data !== undefined) entry.data = data
  process.stdout.write(JSON.stringify(entry) + '\n')
}

export interface Logger {
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
}

export function createLogger(category: string): Logger {
  return {
    info: (msg, data) => write('info', category, msg, data),
    warn: (msg, data) => write('warn', category, msg, data),
    error: (msg, data) => write('error', category, msg, data),
  }
}
