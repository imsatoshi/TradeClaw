/**
 * Minimal structured logger.
 *
 * Output format (one JSON line per entry):
 *   {"ts":"2026-02-21T00:00:00.000Z","level":"info","cat":"scanner","msg":"...","data":{...}}
 *
 * Usage:
 *   const log = createLogger('scanner')
 *   log.info('scan complete', { signals: 3 })
 *   log.warn('ATR is zero for BTC/USDT')
 */

interface LogEntry {
  ts: string
  level: 'info' | 'warn' | 'error'
  cat: string
  msg: string
  data?: unknown
}

function write(level: LogEntry['level'], cat: string, msg: string, data?: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, cat, msg }
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
