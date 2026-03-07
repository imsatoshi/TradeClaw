import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin, EngineContext } from '../core/types.js'
import type { TradePlan } from '../extension/crypto-trading/trade-manager/types.js'

const HISTORY_FILE = resolve('data/trade-plans/history.json')

/** Read recent trade history from disk (last N entries). */
async function readRecentHistory(limit = 20): Promise<TradePlan[]> {
  try {
    const raw = await readFile(HISTORY_FILE, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const plans: TradePlan[] = []
    for (const line of lines.slice(-limit)) {
      try { plans.push(JSON.parse(line)) } catch { /* skip malformed */ }
    }
    return plans.reverse() // newest first
  } catch {
    return []
  }
}

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

    // ==================== Portfolio API ====================

    app.get('/api/portfolio', async (c) => {
      const [account, positions] = ctx.cryptoEngine
        ? await Promise.all([
            ctx.cryptoEngine.getAccount(),
            ctx.cryptoEngine.getPositions(),
          ])
        : [null, []]

      const activePlans = ctx.tradeManager?.getActivePlans() ?? []
      const recentHistory = await readRecentHistory(20)

      const positionDetails = positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        leverage: p.leverage,
        unrealizedPnL: p.unrealizedPnL,
        capitalInvested: p.margin,
        pnlPercent: p.margin > 0 ? (p.unrealizedPnL / p.margin) * 100 : 0,
        liquidationPrice: p.liquidationPrice,
      }))

      return c.json({
        currentTime: new Date().toISOString(),
        equity: account?.equity ?? 0,
        availableBalance: account?.balance ?? 0,
        unrealizedPnL: account?.unrealizedPnL ?? 0,
        realizedPnL: account?.realizedPnL ?? 0,
        totalPnL: account?.totalPnL ?? 0,
        openPositionCount: positions.length,
        positions: positionDetails,
        activePlans: activePlans.map((plan) => ({
          id: plan.id,
          symbol: plan.symbol,
          direction: plan.direction,
          status: plan.status,
          entryPrice: plan.entryPrice,
          positionSize: plan.positionSize,
          stopLoss: plan.stopLoss,
          takeProfits: plan.takeProfits,
          autoBreakeven: plan.autoBreakeven,
          trailingStop: plan.trailingStop,
          realizedPnl: plan.realizedPnl,
          reason: plan.reason,
          createdAt: plan.createdAt,
        })),
        recentHistory: recentHistory.map((plan) => ({
          id: plan.id,
          symbol: plan.symbol,
          direction: plan.direction,
          status: plan.status,
          entryPrice: plan.entryPrice,
          stopLoss: plan.stopLoss.price,
          takeProfits: plan.takeProfits.map(tp => ({
            level: tp.level,
            price: tp.price,
            status: tp.status,
            filledPrice: tp.filledPrice,
          })),
          realizedPnl: plan.realizedPnl,
          reason: plan.reason,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        })),
      })
    })

    // ==================== Portfolio Dashboard (HTML) ====================

    app.get('/portfolio', (c) => {
      return c.html(DASHBOARD_HTML)
    })

    const port = ctx.config.engine.port
    try {
      this.server = serve({ fetch: app.fetch, port }, (info) => {
        console.log(`http plugin listening on http://localhost:${info.port}`)
      })
      // Handle server errors (e.g. EADDRINUSE) without crashing
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`http plugin: port ${port} in use, retrying in 3s...`)
          setTimeout(() => {
            this.server?.close()
            this.server = serve({ fetch: app.fetch, port }, (info) => {
              console.log(`http plugin listening on http://localhost:${info.port} (retry)`)
            })
            this.server.on('error', onError)
          }, 3000)
        } else {
          console.error(`http plugin error: ${err.message}`)
        }
      }
      this.server.on('error', onError)
    } catch (err) {
      console.warn(`http plugin: failed to start on port ${port}: ${err}`)
    }
  }

  async stop() {
    this.server?.close()
  }
}

// ==================== Inline Dashboard HTML ====================

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TradeClaw Portfolio</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 20px; font-size: 1.4em; }
  h2 { color: #8b949e; margin: 20px 0 10px; font-size: 1.1em; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
  .overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; }
  .card .label { color: #8b949e; font-size: 0.8em; margin-bottom: 4px; }
  .card .value { font-size: 1.3em; font-weight: 600; }
  .positive { color: #3fb950; }
  .negative { color: #f85149; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #21262d; font-size: 0.85em; }
  th { color: #8b949e; font-weight: 500; background: #161b22; }
  tr:hover { background: #161b22; }
  .plan-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; margin-bottom: 10px; }
  .plan-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .plan-header .symbol { font-weight: 600; color: #58a6ff; }
  .plan-header .status { font-size: 0.8em; padding: 2px 8px; border-radius: 4px; }
  .status-active { background: #1f6feb33; color: #58a6ff; }
  .status-pending { background: #d2992233; color: #d29922; }
  .status-partial { background: #3fb95033; color: #3fb950; }
  .plan-detail { font-size: 0.82em; color: #8b949e; line-height: 1.6; }
  .tp-list { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
  .tp-item { font-size: 0.8em; padding: 2px 6px; border-radius: 3px; background: #21262d; }
  .tp-filled { background: #3fb95033; color: #3fb950; }
  .tp-placed { background: #1f6feb33; color: #58a6ff; }
  .refresh-info { color: #484f58; font-size: 0.75em; margin-top: 20px; }
  #error { color: #f85149; margin-bottom: 10px; display: none; }
</style>
</head>
<body>
<h1>TradeClaw Portfolio</h1>
<div id="error"></div>
<div class="overview" id="overview"></div>
<h2>Open Positions</h2>
<table id="positions-table"><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Mark</th><th>Size</th><th>Lev</th><th>Capital</th><th>uPnL</th><th>PnL%</th><th>Liq</th></tr></thead><tbody id="positions"></tbody></table>
<h2>Active Trade Plans</h2>
<div id="plans"></div>
<h2>Recent Trade History</h2>
<table id="history-table"><thead><tr><th>Symbol</th><th>Dir</th><th>Entry</th><th>SL</th><th>TPs</th><th>Status</th><th>Realized</th><th>Date</th></tr></thead><tbody id="history"></tbody></table>
<div class="refresh-info" id="refresh-info"></div>

<script>
const $ = (id) => document.getElementById(id);

function fmt(n, d=2) { return n != null ? Number(n).toFixed(d) : '-'; }
function pnlClass(n) { return n >= 0 ? 'positive' : 'negative'; }
function pnlSign(n) { return n >= 0 ? '+' : ''; }

async function refresh() {
  try {
    const res = await fetch('/api/portfolio');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    $('error').style.display = 'none';

    // Overview cards
    $('overview').innerHTML = [
      { label: 'Total Equity', value: '$' + fmt(d.equity) },
      { label: 'Available Balance', value: '$' + fmt(d.availableBalance) },
      { label: 'Unrealized PnL', value: pnlSign(d.unrealizedPnL) + '$' + fmt(d.unrealizedPnL), cls: pnlClass(d.unrealizedPnL) },
      { label: 'Realized PnL', value: pnlSign(d.realizedPnL) + '$' + fmt(d.realizedPnL), cls: pnlClass(d.realizedPnL) },
      { label: 'Total PnL', value: pnlSign(d.totalPnL) + '$' + fmt(d.totalPnL), cls: pnlClass(d.totalPnL) },
      { label: 'Open Positions', value: d.openPositionCount },
    ].map(c => '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + (c.cls||'') + '">' + c.value + '</div></div>').join('');

    // Positions table
    $('positions').innerHTML = d.positions.length === 0
      ? '<tr><td colspan="10" style="color:#484f58">No open positions</td></tr>'
      : d.positions.map(p =>
          '<tr><td>' + p.symbol + '</td><td>' + p.side.toUpperCase() + '</td><td>' + fmt(p.entryPrice) +
          '</td><td>' + fmt(p.markPrice) + '</td><td>' + fmt(p.size, 4) + '</td><td>' + (p.leverage||'-') +
          'x</td><td>$' + fmt(p.capitalInvested) + '</td><td class="' + pnlClass(p.unrealizedPnL) + '">' +
          pnlSign(p.unrealizedPnL) + '$' + fmt(p.unrealizedPnL) + '</td><td class="' + pnlClass(p.pnlPercent) +
          '">' + pnlSign(p.pnlPercent) + fmt(p.pnlPercent, 1) + '%</td><td>' + fmt(p.liquidationPrice) + '</td></tr>'
        ).join('');

    // Active plans
    $('plans').innerHTML = d.activePlans.length === 0
      ? '<div style="color:#484f58;font-size:0.85em">No active trade plans</div>'
      : d.activePlans.map(plan => {
          const tps = plan.takeProfits.map(tp =>
            '<span class="tp-item ' + (tp.status==='filled'?'tp-filled':tp.status==='placed'?'tp-placed':'') +
            '">TP' + tp.level + ': $' + fmt(tp.price) + ' (' + (tp.sizeRatio*100).toFixed(0) + '%, ' + tp.status + ')</span>'
          ).join('');
          return '<div class="plan-card"><div class="plan-header"><span class="symbol">' + plan.symbol + ' ' +
            plan.direction.toUpperCase() + '</span><span class="status status-' + plan.status + '">' +
            plan.status + '</span></div><div class="plan-detail">Entry: $' + fmt(plan.entryPrice) +
            ' | SL: $' + fmt(plan.stopLoss?.price) + ' (' + plan.stopLoss?.status + ')' +
            (plan.autoBreakeven ? ' | Auto-BE: ON' : '') +
            (plan.trailingStop ? ' | Trail: ' + plan.trailingStop.distance + (plan.trailingStop.type==='percent'?'%':'') : '') +
            (plan.realizedPnl ? ' | Realized: $' + fmt(plan.realizedPnl) : '') +
            '<div class="tp-list">' + tps + '</div>' +
            (plan.reason ? '<div style="margin-top:6px;color:#6e7681">' + plan.reason + '</div>' : '') +
            '</div></div>';
        }).join('');

    // History
    $('history').innerHTML = d.recentHistory.length === 0
      ? '<tr><td colspan="8" style="color:#484f58">No trade history</td></tr>'
      : d.recentHistory.map(h =>
          '<tr><td>' + h.symbol + '</td><td>' + h.direction.toUpperCase() + '</td><td>' + fmt(h.entryPrice) +
          '</td><td>' + fmt(h.stopLoss) + '</td><td>' + h.takeProfits.map(tp =>
            tp.filledPrice ? fmt(tp.filledPrice) : fmt(tp.price)
          ).join(' / ') + '</td><td>' + h.status + '</td><td class="' +
          pnlClass(h.realizedPnl||0) + '">' + (h.realizedPnl != null ? pnlSign(h.realizedPnl) + '$' + fmt(h.realizedPnl) : '-') +
          '</td><td>' + (h.createdAt ? new Date(h.createdAt).toLocaleDateString() : '-') + '</td></tr>'
        ).join('');

    $('refresh-info').textContent = 'Last refresh: ' + new Date().toLocaleTimeString() + ' (auto-refresh every 30s)';
  } catch(e) {
    $('error').textContent = 'Failed to load: ' + e.message;
    $('error').style.display = 'block';
  }
}

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`
