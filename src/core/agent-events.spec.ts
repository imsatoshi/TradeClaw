import { describe, it, expect, beforeEach } from 'vitest'
import {
  emit,
  on,
  onStream,
  enqueueSystemEvent,
  drainSystemEvents,
  peekSystemEvents,
  hasSystemEvents,
  _resetForTest,
} from './agent-events.js'

beforeEach(() => {
  _resetForTest()
})

describe('agent-events', () => {
  describe('emit / on', () => {
    it('should deliver events to global listeners', () => {
      const received: unknown[] = []
      on((evt) => received.push(evt))

      emit('lifecycle', { action: 'start' })

      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({
        seq: 1,
        stream: 'lifecycle',
        data: { action: 'start' },
      })
    })

    it('should assign monotonic seq per stream', () => {
      const received: unknown[] = []
      on((evt) => received.push(evt))

      emit('lifecycle', { n: 1 })
      emit('lifecycle', { n: 2 })
      emit('heartbeat', { n: 1 })

      expect(received).toHaveLength(3)
      expect((received[0] as any).seq).toBe(1)
      expect((received[1] as any).seq).toBe(2)
      // heartbeat stream has its own counter
      expect((received[2] as any).seq).toBe(1)
    })

    it('should include a timestamp', () => {
      const before = Date.now()
      const evt = emit('lifecycle', {})
      const after = Date.now()

      expect(evt.ts).toBeGreaterThanOrEqual(before)
      expect(evt.ts).toBeLessThanOrEqual(after)
    })

    it('should return an unsubscribe function', () => {
      const received: unknown[] = []
      const unsub = on((evt) => received.push(evt))

      emit('lifecycle', { n: 1 })
      unsub()
      emit('lifecycle', { n: 2 })

      expect(received).toHaveLength(1)
    })

    it('should swallow listener errors', () => {
      on(() => { throw new Error('boom') })
      const received: unknown[] = []
      on((evt) => received.push(evt))

      // Should not throw
      emit('lifecycle', {})
      expect(received).toHaveLength(1)
    })
  })

  describe('onStream', () => {
    it('should only receive events for the subscribed stream', () => {
      const heartbeats: unknown[] = []
      onStream('heartbeat', (evt) => heartbeats.push(evt))

      emit('lifecycle', { action: 'start' })
      emit('heartbeat', { status: 'ok' })
      emit('cron', { job: 'test' })

      expect(heartbeats).toHaveLength(1)
      expect((heartbeats[0] as any).data).toEqual({ status: 'ok' })
    })

    it('should unsubscribe cleanly', () => {
      const received: unknown[] = []
      const unsub = onStream('heartbeat', (evt) => received.push(evt))

      emit('heartbeat', { n: 1 })
      unsub()
      emit('heartbeat', { n: 2 })

      expect(received).toHaveLength(1)
    })

    it('should deliver to both global and stream listeners', () => {
      const global: unknown[] = []
      const stream: unknown[] = []

      on((evt) => global.push(evt))
      onStream('cron', (evt) => stream.push(evt))

      emit('cron', { job: 'test' })

      expect(global).toHaveLength(1)
      expect(stream).toHaveLength(1)
    })
  })

  describe('system event queue', () => {
    it('should enqueue and drain events', () => {
      enqueueSystemEvent({ id: 'e1', source: 'cron', text: 'reminder 1' })
      enqueueSystemEvent({ id: 'e2', source: 'manual', text: 'check this' })

      expect(hasSystemEvents()).toBe(true)
      expect(peekSystemEvents()).toHaveLength(2)

      const drained = drainSystemEvents()
      expect(drained).toHaveLength(2)
      expect(drained[0].id).toBe('e1')
      expect(drained[1].id).toBe('e2')

      // Queue is now empty
      expect(hasSystemEvents()).toBe(false)
      expect(drainSystemEvents()).toHaveLength(0)
    })

    it('should add timestamps to enqueued events', () => {
      const before = Date.now()
      enqueueSystemEvent({ id: 'e1', source: 'cron', text: 'test' })
      const after = Date.now()

      const events = drainSystemEvents()
      expect(events[0].ts).toBeGreaterThanOrEqual(before)
      expect(events[0].ts).toBeLessThanOrEqual(after)
    })

    it('should dedup by contextKey', () => {
      enqueueSystemEvent({ id: 'e1', source: 'cron', text: 'v1', contextKey: 'job:abc' })
      enqueueSystemEvent({ id: 'e2', source: 'cron', text: 'v2', contextKey: 'job:abc' })

      const events = drainSystemEvents()
      expect(events).toHaveLength(1)
      expect(events[0].text).toBe('v2') // replaced with newer content
      expect(events[0].id).toBe('e2')   // id from the replacement event
    })

    it('should not dedup events without contextKey', () => {
      enqueueSystemEvent({ id: 'e1', source: 'cron', text: 'first' })
      enqueueSystemEvent({ id: 'e2', source: 'cron', text: 'second' })

      expect(drainSystemEvents()).toHaveLength(2)
    })

    it('should evict oldest when over capacity', () => {
      for (let i = 0; i < 60; i++) {
        enqueueSystemEvent({ id: `e${i}`, source: 'cron', text: `event ${i}` })
      }

      const events = drainSystemEvents()
      expect(events).toHaveLength(50) // capped at 50
      expect(events[0].id).toBe('e10') // oldest 10 evicted
    })

    it('peek should not drain the queue', () => {
      enqueueSystemEvent({ id: 'e1', source: 'cron', text: 'test' })

      expect(peekSystemEvents()).toHaveLength(1)
      expect(peekSystemEvents()).toHaveLength(1) // still there
      expect(hasSystemEvents()).toBe(true)
    })
  })
})
