/**
 * Generic retry utility with exponential backoff.
 *
 * Used across the codebase for resilient API calls:
 * - Scheduler heartbeat retries
 * - Freqtrade API calls
 * - Exchange data fetching
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Base delay in ms before first retry (default: 1000) */
  baseDelayMs?: number
  /** Maximum delay cap in ms (default: 30000) */
  maxDelayMs?: number
  /** Multiplier for each subsequent retry (default: 2) */
  factor?: number
  /** Label for log messages */
  label?: string
  /** Classify errors: return true for transient (retryable), false for permanent */
  isTransient?: (error: unknown) => boolean
}

/**
 * Execute `fn` with exponential backoff retries.
 *
 * Delay sequence (defaults): 1s → 2s → 4s → 8s → 16s → 30s (capped)
 *
 * @throws The last error if all retries are exhausted
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    factor = 2,
    label,
    isTransient,
  } = opts

  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // Permanent error — don't retry
      if (isTransient && !isTransient(err)) {
        throw err
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(factor, attempt), maxDelayMs)
        if (label) {
          console.warn(`${label}: attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms`)
        }
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  throw lastError
}

/**
 * Default transient error classifier.
 * Returns true for network errors, timeouts, and 5xx HTTP errors.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return true // unknown errors → retry

  const msg = err.message.toLowerCase()

  // Permanent errors — don't retry
  if (msg.includes('api key')) return false
  if (msg.includes('unauthorized')) return false
  if (msg.includes('forbidden')) return false
  if (msg.includes('not found')) return false
  if (msg.includes('invalid')) return false
  if (msg.includes('400')) return false
  if (msg.includes('401')) return false
  if (msg.includes('403')) return false
  if (msg.includes('404')) return false

  // Transient — retry
  return true
}
