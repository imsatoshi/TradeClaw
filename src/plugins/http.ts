import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { Plugin, EngineContext } from '../core/types.js'

export class HttpPlugin implements Plugin {
  name = 'http'
  private server: ReturnType<typeof serve> | null = null

  async start(ctx: EngineContext) {
    const app = new Hono()

    app.get('/health', (c) => c.json({ ok: true }))

    app.get('/status', async (c) => {
      const [account, positions, orders] = ctx.cryptoEngine
        ? await Promise.all([
            ctx.cryptoEngine.getAccount(),
            ctx.cryptoEngine.getPositions(),
            ctx.cryptoEngine.getOrders(),
          ])
        : [null, [], []]
      return c.json({
        currentTime: new Date().toISOString(),
        account,
        positions,
        orders,
      })
    })

    const port = ctx.config.engine.port
    try {
      this.server = serve({ fetch: app.fetch, port }, (info) => {
        console.log(`http plugin listening on http://localhost:${info.port}`)
      })
      // Handle server errors (e.g. EADDRINUSE) without crashing
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`http plugin: port ${port} in use, retrying in 3s...`)
          setTimeout(() => {
            this.server?.close()
            this.server = serve({ fetch: app.fetch, port }, (info) => {
              console.log(`http plugin listening on http://localhost:${info.port} (retry)`)
            })
          }, 3000)
        } else {
          console.error(`http plugin error: ${err.message}`)
        }
      })
    } catch (err) {
      console.warn(`http plugin: failed to start on port ${port}: ${err}`)
    }
  }

  async stop() {
    this.server?.close()
  }
}
