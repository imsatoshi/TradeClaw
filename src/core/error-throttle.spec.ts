import { describe, it, expect } from 'vitest'
import { ErrorThrottle } from './error-throttle.js'

describe('ErrorThrottle', () => {
  it('reports first occurrence', () => {
    const throttle = new ErrorThrottle(5000)
    expect(throttle.shouldReport('api-fail', 1000)).toBe(true)
  })

  it('suppresses duplicate within window', () => {
    const throttle = new ErrorThrottle(5000)
    expect(throttle.shouldReport('api-fail', 1000)).toBe(true)
    expect(throttle.shouldReport('api-fail', 2000)).toBe(false)
    expect(throttle.shouldReport('api-fail', 5000)).toBe(false)
  })

  it('reports again after window expires', () => {
    const throttle = new ErrorThrottle(5000)
    expect(throttle.shouldReport('api-fail', 1000)).toBe(true)
    expect(throttle.shouldReport('api-fail', 6001)).toBe(true)
  })

  it('tracks different keys independently', () => {
    const throttle = new ErrorThrottle(5000)
    expect(throttle.shouldReport('api-fail', 1000)).toBe(true)
    expect(throttle.shouldReport('timeout', 1000)).toBe(true)
    expect(throttle.shouldReport('api-fail', 2000)).toBe(false)
    expect(throttle.shouldReport('timeout', 2000)).toBe(false)
  })

  it('clear resets a specific key', () => {
    const throttle = new ErrorThrottle(5000)
    throttle.shouldReport('api-fail', 1000)
    throttle.clear('api-fail')
    expect(throttle.shouldReport('api-fail', 2000)).toBe(true)
  })

  it('clearAll resets everything', () => {
    const throttle = new ErrorThrottle(5000)
    throttle.shouldReport('a', 1000)
    throttle.shouldReport('b', 1000)
    throttle.clearAll()
    expect(throttle.shouldReport('a', 2000)).toBe(true)
    expect(throttle.shouldReport('b', 2000)).toBe(true)
  })

  it('cleans up stale entries after 1 hour', () => {
    const throttle = new ErrorThrottle(5000)
    // Add some entries
    throttle.shouldReport('old-key-1', 1000)
    throttle.shouldReport('old-key-2', 1000)
    throttle.shouldReport('recent-key', 1000)

    // Jump forward 1 hour + 1ms — triggers cleanup
    const oneHourLater = 1000 + 60 * 60 * 1000 + 1
    // 'recent-key' reported again just before cleanup so it's still within window
    throttle.shouldReport('recent-key', oneHourLater - 3000) // refresh it

    // Trigger cleanup by calling shouldReport after 1 hour
    throttle.shouldReport('trigger', oneHourLater)

    // old keys should have been cleaned up, so reporting them again should return true
    expect(throttle.shouldReport('old-key-1', oneHourLater + 1)).toBe(true)
    expect(throttle.shouldReport('old-key-2', oneHourLater + 1)).toBe(true)
  })
})
