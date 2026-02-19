import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'

// Test the HTTP routes in isolation — no server, no engine
function createTestApp() {
  const state = {
    positions: [{ pair: 'BTC/USDT', side: 'long' as const, size: 0.1, entryPrice: 95000, openedAt: '2025-01-01' }],
    orders: [],
  }

  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  app.get('/status', (c) =>
    c.json({
      positions: state.positions,
      orders: state.orders,
    }),
  )

  return { app, state }
}

describe('HTTP routes', () => {
  it('GET /health returns ok', async () => {
    const { app } = createTestApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('GET /status returns state', async () => {
    const { app } = createTestApp()
    const res = await app.request('/status')
    const body = await res.json()
    expect(body.positions).toHaveLength(1)
    expect(body.positions[0].pair).toBe('BTC/USDT')
  })
})
