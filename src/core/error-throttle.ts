/**
 * Error throttle — suppress repeated identical errors within a time window.
 *
 * Use to prevent log spam when an API is down or a recurring error happens.
 * Only the first occurrence within the window triggers reporting.
 */

const DEFAULT_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

export class ErrorThrottle {
  private seen = new Map<string, number>()
  private windowMs: number

  constructor(windowMs = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs
  }

  /**
   * Returns true if this error key should be reported (first in window).
   * Returns false if it was already reported within the window (suppress).
   */
  shouldReport(key: string, nowMs = Date.now()): boolean {
    const last = this.seen.get(key)
    if (last != null && (nowMs - last) < this.windowMs) {
      return false
    }
    this.seen.set(key, nowMs)
    return true
  }

  /** Reset tracking for a specific key. */
  clear(key: string): void {
    this.seen.delete(key)
  }

  /** Reset all tracking. */
  clearAll(): void {
    this.seen.clear()
  }
}

/** Global singleton for general use. */
export const errorThrottle = new ErrorThrottle()
