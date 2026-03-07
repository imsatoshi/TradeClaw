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
})
