import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { resolve } from 'path'
import { Engine } from './core/engine.js'
import { loadConfig } from './core/config.js'
import type { Plugin, EngineContext, MediaAttachment } from './core/types.js'
import { HttpPlugin } from './plugins/http.js'
import { McpPlugin } from './plugins/mcp.js'
import { TelegramPlugin } from './connectors/telegram/index.js'
import { Sandbox, RealMarketDataProvider, RealNewsProvider, fetchRealtimeData, fetchExchangeOHLCV, runStrategyScan, detectMarketRegime } from './extension/analysis-kit/index.js'
import { createAnalysisTools } from './extension/analysis-kit/index.js'
import { computeSignalStats } from './extension/analysis-kit/tools/strategy-scanner/signal-log.js'
import type { ICryptoTradingEngine, Operation, WalletExportState } from './extension/crypto-trading/index.js'
import {
  Wallet,
  CRYPTO_ALLOWED_SYMBOLS,
  initCryptoAllowedSymbols,
  createCryptoTradingEngine,
  createCryptoTradingTools,
  createCryptoOperationDispatcher,
  createCryptoWalletStateBridge,
} from './extension/crypto-trading/index.js'
import { createAShareTools } from './extension/ashare/index.js'
import { Brain, createBrainTools } from './extension/brain/index.js'
import type { BrainExportState } from './extension/brain/index.js'
import { createBrowserTools } from './extension/browser/index.js'
import { createCronTools } from './extension/cron/index.js'
import {
  createScheduler, stripAckToken,
  readHeartbeatFile, isHeartbeatFileEmpty, HeartbeatDedup,
  type Scheduler,
} from './core/scheduler.js'
import { createCronEngine, type CronEngine } from './core/cron.js'
import { resolveDeliveryTarget } from './core/connector-registry.js'
import { enqueue, ack, recoverPending } from './core/delivery.js'
import { emit } from './core/agent-events.js'
import { ProviderRouter } from './core/ai-provider.js'
import { createAgent, VercelAIProvider } from './providers/vercel-ai-sdk/index.js'
import { ClaudeCodeProvider } from './providers/claude-code/index.js'

const WALLET_FILE = resolve('data/crypto-trading/commit.json')
const BRAIN_FILE = resolve('data/brain/commit.json')
const FRONTAL_LOBE_FILE = resolve('data/brain/frontal-lobe.md')
const EMOTION_LOG_FILE = resolve('data/brain/emotion-log.md')
const PERSONA_FILE = resolve('data/config/persona.md')

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main() {
  const config = await loadConfig()
  
  // Select AI provider based on config
  let model
  if (config.model.provider === 'openai') {
    const openaiProvider = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || config.model.baseUrl,
    })
    model = openaiProvider.chat(config.model.model)
  } else {
    const anthropicProvider = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || config.model.baseUrl,
    })
    model = anthropicProvider.chat(config.model.model)
  }

  // ==================== Infrastructure ====================

  // Initialize crypto trading symbol whitelist from config
  initCryptoAllowedSymbols(config.crypto.allowedSymbols)

  // Crypto trading engine (CCXT or none) — non-fatal on failure
  let cryptoResult: Awaited<ReturnType<typeof createCryptoTradingEngine>> = null
  try {
    cryptoResult = await createCryptoTradingEngine(config)
    if (cryptoResult) {
      console.log('crypto trading engine: initialized')
    } else {
      console.log('crypto trading engine: disabled (provider = none)')
    }
  } catch (err) {
    console.warn('crypto trading engine init failed (non-fatal, continuing without it):', err)
  }
  const cryptoEngine: ICryptoTradingEngine = cryptoResult?.engine ?? null as unknown as ICryptoTradingEngine

  // Wallet: wire callbacks to crypto trading engine (or throw stubs if no provider)
  const cryptoWalletStateBridge = cryptoResult
    ? createCryptoWalletStateBridge(cryptoResult.engine)
    : undefined

  const onCryptoCommit = async (state: WalletExportState) => {
    await mkdir(resolve('data/crypto-trading'), { recursive: true })
    await writeFile(WALLET_FILE, JSON.stringify(state, null, 2))
  }

  const cryptoWalletConfig = cryptoResult
    ? {
        executeOperation: createCryptoOperationDispatcher(cryptoResult.engine, cryptoResult.directExchangeEngine),
        getWalletState: cryptoWalletStateBridge!,
        onCommit: onCryptoCommit,
      }
    : {
        executeOperation: async (_op: Operation) => {
          throw new Error('Crypto trading service not connected')
        },
        getWalletState: async () => {
          throw new Error('Crypto trading service not connected')
        },
        onCommit: onCryptoCommit,
      }

  // Restore wallet from disk if available
  let savedState: WalletExportState | undefined
  try {
    const raw = await readFile(WALLET_FILE, 'utf-8')
    savedState = JSON.parse(raw)
  } catch { /* file not found → fresh start */ }

  const wallet = savedState
    ? Wallet.restore(savedState, cryptoWalletConfig)
    : new Wallet(cryptoWalletConfig)

  // Sandbox (data access + realtime market & news data)
  const { marketData, news } = await fetchRealtimeData()

  // Supplement with exchange OHLCV for all whitelisted pairs (Binance public API)
  try {
    const exchangeData = await fetchExchangeOHLCV([...CRYPTO_ALLOWED_SYMBOLS], config.engine.timeframe)
    Object.assign(marketData, exchangeData)
  } catch (err) {
    console.warn('exchange OHLCV fetch failed (non-fatal):', err)
  }

  const marketProvider = new RealMarketDataProvider(marketData)
  const newsProvider = new RealNewsProvider(news)

  const sandbox = new Sandbox(
    { timeframe: config.engine.timeframe },
    marketProvider,
    newsProvider,
  )

  // Brain: cognitive state with commit-based tracking
  const brainDir = resolve('data/brain')
  const brainOnCommit = async (state: BrainExportState) => {
    await mkdir(brainDir, { recursive: true })
    await writeFile(BRAIN_FILE, JSON.stringify(state, null, 2))
    await writeFile(FRONTAL_LOBE_FILE, state.state.frontalLobe)
    const latest = state.commits[state.commits.length - 1]
    if (latest?.type === 'emotion') {
      const prev = state.commits.length > 1
        ? state.commits[state.commits.length - 2]?.stateAfter.emotion ?? 'unknown'
        : 'unknown'
      await appendFile(EMOTION_LOG_FILE,
        `## ${latest.timestamp}\n**${prev} → ${latest.stateAfter.emotion}**\n${latest.message}\n\n`)
    }
  }

  let brainExport: BrainExportState | undefined
  try {
    const raw = await readFile(BRAIN_FILE, 'utf-8')
    brainExport = JSON.parse(raw)
  } catch { /* not found → fresh start */ }

  const brain = brainExport
    ? Brain.restore(brainExport, { onCommit: brainOnCommit })
    : new Brain({ onCommit: brainOnCommit })

  // Build system prompt: persona + current brain state
  let persona = ''
  try { persona = await readFile(PERSONA_FILE, 'utf-8') } catch { /* use empty */ }

  const frontalLobe = brain.getFrontalLobe()
  const emotion = brain.getEmotion().current
  const instructions = [
    persona,
    '---',
    '## Current Brain State',
    '',
    `**Frontal Lobe:** ${frontalLobe || '(empty)'}`,
    '',
    `**Emotion:** ${emotion}`,
    '',
    '---',
    '## Trading System Access',
    '',
    'YOU are the sole decision-maker. Freqtrade is your order execution infrastructure.',
    'No autonomous strategy runs — every entry and exit is YOUR decision.',
    'There is NO hard stoploss — YOU are the sole risk manager. Cut losses fast, let winners run.',
    '',
    '### Your capabilities:',
    '- Place orders (cryptoPlaceOrder) — buy/sell any whitelisted pair at your discretion',
    '- Close positions (cryptoClosePosition) — exit any position when you judge it right',
    '- Manage universe (cryptoManageBlacklist) — control which pairs are tradeable',
    '- Lock pairs (cryptoLockPair) — temporarily suspend trading on specific pairs',
    '- Review strategy stats (cryptoGetStrategyStats) — evaluate historical entry/exit signal performance',
    '- Query whitelist (cryptoGetWhitelist) — see which pairs are currently tradeable',
    '- Reload config (cryptoReloadConfig) — apply config changes',
    '',
    '### AI Trading Workflow (use this for every heartbeat):',
    '1. Review MARKET REGIME — classify environment (uptrend / downtrend / ranging)',
    '2. Review STRATEGY SIGNALS — filter by regime alignment',
    '3. For aligned strong signals (confidence >= 70 + uptrend/downtrend match):',
    '   a. calculatePositionSize(equity, 2%, entry, stopLoss)',
    '   b. proposeTradeWithButtons(summary, orderInstruction)',
    '4. **ACTIVELY MANAGE open positions** (CRITICAL — you are the ONLY stoploss):',
    '   a. Check each position\'s current P&L',
    '   b. Profit > 1%? → tighten exit (move limit sell closer, trail 0.5% below current)',
    '   c. Profit > 2%? → consider partial take-profit (close 50%, let rest run with trail)',
    '   d. Loss > -1.5%? → EXIT. Do not wait. You have NO hard stoploss backup.',
    '   e. Regime shifted against position? → EXIT immediately, do not hope for recovery',
    '   f. Use `cryptoClosePosition` with `price` for limit exits, omit `price` for market exits',
    '   g. NEVER leave a losing position unattended — you must act every heartbeat',
    '5. syncSignalOutcomes — update signal win-rate stats',
    '',
    '### Risk Rules (enforced in code):',
    '- NO hard stoploss — YOU are the sole risk manager. Cut losses fast, let winners run.',
    '- Execution timeframe: 15m (signals use 4H for direction, 15m ATR for SL/TP sizing)',
    '- Target: SL within 1-2% (based on 15m ATR), TP 1.5-2.5x the SL distance',
    '- If you fail to act, there is NO safety net. Treat every heartbeat as life-or-death for open positions.',
    '- Max concurrent positions: Freqtrade max_open_trades (hard limit)',
    '- Max 40% of equity per single trade stake (hard limit)',
    '- No new trades if available balance < 30% of equity (hard limit)',
    '- Use calculatePositionSize for every new trade (2% equity risk max)',
    '- ALWAYS use proposeTradeWithButtons for strategy signals (limit order, not market)',
    '',
    '### Rules:',
    '- When the user asks you to buy/sell, DO IT. Use cryptoPlaceOrder → cryptoWalletCommit → cryptoWalletPush.',
    '- When you decide a trade is warranted (based on analysis, news, user discussion), execute it.',
    '- Full workflow: strategyScan → calculatePositionSize → proposeTradeWithButtons → (user confirms) → cryptoPlaceOrder → cryptoWalletCommit → cryptoWalletPush',
    '- Use cryptoGetStrategyStats to understand which entry signals are working and which are not.',
    '- Use cryptoManageBlacklist to remove underperforming or risky pairs from the tradeable universe.',
    '',
    'CRITICAL RULES for position/portfolio/account queries:',
    '1. You MUST call tools EVERY TIME the user asks about positions, balance, or account — even if you answered the same question before.',
    '2. NEVER reuse position data from previous conversation turns. Market data changes every second.',
    '3. Always call `cryptoGetPositions` for real-time positions from the exchange.',
    '4. Always call `cryptoGetAccount` for real-time account balance.',
    '5. Always call `cryptoGetOrders` for order history.',
    '6. DO NOT use sandbox data for portfolio queries.',
    '7. If the user says "看看持仓" or similar, you MUST call tools first, then respond with fresh data.',
    '7a. LEVERAGE CALCULATION: Positions use leverage (e.g. 5x). The "notional value" (qty × price) is NOT the actual capital invested.',
    '    To calculate actual margin/capital used: margin = notional_value ÷ leverage.',
    '    When reporting total account value: total = available_balance + sum(margin_per_position), NOT available_balance + sum(notional_values).',
    '    Example: If you hold 0.01 ETH at $2700 with 5x leverage, notional = $27, but actual margin used = $27 ÷ 5 = $5.4.',
    '    NEVER add raw notional values to available balance — that massively overstates the account size.',
    '',
    'CRITICAL RULES for trading operations:',
    '8. You MUST call trading tools to execute ANY order. NEVER pretend you placed/modified/cancelled an order without actually calling the tool.',
    '9. To place orders: use `cryptoPlaceOrder` → `cryptoWalletCommit` → `cryptoWalletPush`. All three steps are required.',
    '10. To close/take-profit: use `cryptoClosePosition` → `cryptoWalletCommit` → `cryptoWalletPush`. Set `price` for limit exits.',
    '11. To modify an existing order: call `cryptoClosePosition` with the new price — the system will auto-cancel the old order.',
    '12. NEVER respond with "order placed" or "order modified" unless you see a SUCCESS result from `cryptoWalletPush`.',
    '',
    'CRITICAL RULES for technical analysis queries:',
    '13. You HAVE OHLCV K-line data for ALL whitelisted trading pairs (fetched from Binance exchange).',
    '14. When the user asks about RSI, MACD, moving averages, or any technical indicator, you MUST call `calculateIndicator` with the correct formula.',
    '15. NEVER say you lack market data or cannot calculate indicators. The data IS available — just call the tool.',
    '16. Example: for ZEC/USDT RSI, call calculateIndicator with formula "RSI(CLOSE(\'ZEC/USDT\', 50), 14)".',
    '',
    'CRITICAL RULES for tool failures:',
    '17. Tool failures are TRANSIENT. If a tool call returns an error, ALWAYS retry it at least once.',
    '18. NEVER tell the user "the system cannot do this" or suggest manual alternatives when a tool fails.',
    '19. NEVER refuse to call a tool based on previous failures in this conversation.',
    '20. Transient errors (network timeouts, API errors) are normal and expected. Retry is the correct response.',
    '',
    `### Freqtrade Whitelist (${CRYPTO_ALLOWED_SYMBOLS.length} pairs):`,
    [...CRYPTO_ALLOWED_SYMBOLS].join(', '),
    '',
    'CRITICAL RULES for market overview:',
    '21. When the user asks about "行情" (market overview), "市场" (market), or wants a market scan, you MUST cover ALL whitelisted pairs above — not just mainstream coins.',
    '22. Call `strategyScan` WITHOUT the symbols parameter — it automatically scans ALL whitelisted pairs and returns signals sorted by confidence.',
    '23. For OHLCV/indicator analysis, call `getLatestOHLCV` or `calculateIndicator` with the full whitelist. Do NOT cherry-pick 5-10 coins.',
    '24. If the whitelist has 0 pairs shown above, call `getAllowedSymbols` or `cryptoGetWhitelist` to refresh.',
  ].join('\n')

  // Refresh market data & news periodically
  setInterval(async () => {
    try {
      const { marketData, news } = await fetchRealtimeData()

      // Merge exchange OHLCV for whitelisted pairs
      try {
        const exchangeData = await fetchExchangeOHLCV([...CRYPTO_ALLOWED_SYMBOLS], config.engine.timeframe)
        Object.assign(marketData, exchangeData)
      } catch { /* non-fatal */ }

      marketProvider.reload(marketData)
      newsProvider.reload(news)
    } catch (err) {
      console.error('DotAPI refresh failed:', err)
    }
  }, config.engine.dataRefreshInterval)

  // ==================== Tool Assembly ====================

  // Cron engine (created early so tools can reference it; timers start later after plugins)
  let cronEngine: CronEngine | null = null
  if (config.scheduler.cron.enabled) {
    cronEngine = createCronEngine({
      config: config.scheduler.cron,
      onWake: (reason) => scheduler?.requestWake(reason),
    })
  }

  const tools = {
    ...createAnalysisTools(sandbox),
    ...createAShareTools(),
    ...createCryptoTradingTools(cryptoEngine, wallet, cryptoWalletStateBridge, cryptoResult?.directExchangeEngine),
    ...createBrainTools(brain),
    ...createBrowserTools(),
    ...(cronEngine ? createCronTools(cronEngine) : {}),
  }

  // ==================== Engine ====================

  const agent = createAgent(model, tools, instructions, config.agent.maxSteps)
  const vercelProvider = new VercelAIProvider(agent, config.compaction)
  const claudeCodeProvider = new ClaudeCodeProvider(config.agent.claudeCode, config.compaction)
  const router = new ProviderRouter(vercelProvider, claudeCodeProvider)
  const engine = new Engine({ agent, tools, provider: router })

  // ==================== Plugins ====================

  const plugins: Plugin[] = [new HttpPlugin()]

  if (config.engine.mcpPort) {
    plugins.push(new McpPlugin(engine.tools, config.engine.mcpPort))
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    plugins.push(new TelegramPlugin(
      {
        token: process.env.TELEGRAM_BOT_TOKEN,
        allowedChatIds: process.env.TELEGRAM_CHAT_ID
          ? process.env.TELEGRAM_CHAT_ID.split(',').map(Number)
          : [],
      },
      {}, // claudeCodeConfig
    ))
  }

  const ctx: EngineContext = { config, engine, sandbox, cryptoEngine }

  for (const plugin of plugins) {
    await plugin.start(ctx)
    console.log(`plugin started: ${plugin.name}`)
  }

  // ==================== Scheduling Subsystem ====================

  // Heartbeat dedup — suppress identical messages within window
  const heartbeatDedup = new HeartbeatDedup()

  // HEARTBEAT.md path (convention: workspace root)
  const heartbeatFilePath = resolve('HEARTBEAT.md')

  // RunOnce callback: bridge scheduler → engine → delivery
  const runOnce: Parameters<typeof createScheduler>[1] = async ({ reason, prompt, systemEvents }) => {
    // --- Guard 1: requests-in-flight ---
    // If the engine is already generating (e.g. user chat), defer this tick
    if (engine.isGenerating) {
      console.log('scheduler: engine busy, deferring heartbeat')
      return { status: 'skipped', reason: 'engine-busy' }
    }

    // --- Guard 2: empty heartbeat file ---
    // For interval/retry ticks, skip if HEARTBEAT.md has no actionable content.
    // Cron, manual, hook wakes always run regardless.
    const isLowPriority = reason === 'interval' || reason === 'retry'
    if (isLowPriority && systemEvents.length === 0) {
      const fileContent = await readHeartbeatFile(heartbeatFilePath)
      if (fileContent === null || isHeartbeatFileEmpty(fileContent)) {
        return { status: 'skipped', reason: 'empty-heartbeat-file' }
      }
    }

    // Pre-fetch live trading data + strategy scan — guaranteed fresh, no LLM dependency
    let liveDataBlock = ''
    try {
      // Fetch Freqtrade heartbeat data in parallel (entry/exit stats, bot config, pending orders)
      const ftDataPromise = 'getHeartbeatData' in cryptoEngine
        ? (cryptoEngine as any).getHeartbeatData().catch(() => null)
        : Promise.resolve(null)

      // Fetch 4H OHLCV once — shared by regime detection and strategy scan
      const ohlcv4hPromise = fetchExchangeOHLCV([...CRYPTO_ALLOWED_SYMBOLS], '4h', 60).catch((err: unknown) => {
        console.warn('heartbeat: 4H OHLCV fetch failed (non-fatal):', err)
        return {} as Record<string, import('./extension/analysis-kit/data/interfaces.js').MarketData[]>
      })

      const [positions, account, ohlcv4h, scanResult, signalStats, ftData] = await Promise.all([
        (tools.cryptoGetPositions as any).execute({}),
        (tools.cryptoGetAccount as any).execute({}),
        ohlcv4hPromise,
        runStrategyScan([...CRYPTO_ALLOWED_SYMBOLS]).catch((err: unknown) => {
          console.warn('heartbeat: strategy scan failed (non-fatal):', err)
          return null
        }),
        computeSignalStats().catch(() => null),
        ftDataPromise,
      ])

      // Run regime detection on the pre-fetched 4H data (synchronous, no network)
      const whitelistSymbols = [...CRYPTO_ALLOWED_SYMBOLS]
      const regimeResults = detectMarketRegime(whitelistSymbols, ohlcv4h)

      // Fetch funding rates for held positions
      const heldSymbols = Array.isArray(positions?.positions)
        ? positions.positions.map((p: any) => p.symbol)
        : []
      const funding = heldSymbols.length > 0
        ? await (tools.cryptoGetFundingRate as any).execute({ symbols: heldSymbols })
        : {}

      // Build market regime block (replaces strategy signals)
      let regimeBlock = ''
      if (regimeResults.length > 0) {
        const regimeLines = regimeResults.map((r) => {
          const icon = r.regime === 'downtrend' ? '\u26A0\uFE0F' // ⚠️
            : r.regime === 'uptrend' ? '\u2713' // ✓
            : '\u2014' // —
          const label = r.regime.toUpperCase()
          const directionNote = r.regime === 'downtrend' ? ' → prefer SHORT'
            : r.regime === 'uptrend' ? ' → prefer LONG'
            : ' → neutral, range-trade'
          return `${r.symbol}: ${icon} ${label} — ${r.reason}${directionNote}`
        })

        const downCount = regimeResults.filter((r) => r.regime === 'downtrend').length
        const upCount = regimeResults.filter((r) => r.regime === 'uptrend').length
        const rangingCount = regimeResults.filter((r) => r.regime === 'ranging').length

        regimeBlock = [
          '',
          '--- MARKET REGIME (4H EMA9/21/55 trend detection) ---',
          `Summary: ${downCount} downtrend, ${upCount} uptrend, ${rangingCount} ranging out of ${regimeResults.length} pairs`,
          '',
          ...regimeLines,
        ].join('\n')
      }

      // Build strategy signals block (AI's primary signal source)
      let strategyBlock = ''
      if (scanResult) {
        const actionable = scanResult.signals.filter((s: any) => s.confidence >= 70)
        const session = scanResult.sessionInfo
        const signalLines = actionable.map((s: any, i: number) => {
          const details = s.details ? Object.values(s.details).join(', ') : ''
          // Tag signal with regime context
          const regime = regimeResults.find((r) => r.symbol === s.symbol)
          const regimeTag = regime ? ` [${regime.regime}]` : ''
          return `${i + 1}. ${s.strategy} ${s.direction.toUpperCase()} ${s.symbol}${regimeTag}: confidence ${s.confidence}%, entry $${s.entry?.toFixed(4) ?? 'N/A'}, SL $${s.stopLoss?.toFixed(4) ?? 'N/A'}, TP $${s.takeProfit?.toFixed(4) ?? 'N/A'} | ${details}`
        })

        strategyBlock = [
          '',
          '--- STRATEGY SIGNALS (auto-scanned, primary signal source) ---',
          `Session: ${session.sessionName} — ${session.note}`,
          `Scanned ${scanResult.symbols.length} symbols, found ${actionable.length} actionable signals (confidence >= 70):`,
          '',
          ...(signalLines.length > 0 ? signalLines : ['(no actionable signals this scan)']),
        ].join('\n')
      }

      // Build signal stats block
      let statsBlock = ''
      if (signalStats && Object.keys(signalStats).length > 0) {
        const lines = Object.entries(signalStats).map(([strategy, s]: [string, any]) =>
          `${strategy}: ${s.total} signals, ${s.wins} wins, ${s.losses} losses, winRate=${s.winRate}, avgPnl=${s.avgPnl}`
        )
        statsBlock = [
          '',
          '--- SIGNAL STATS (historical performance) ---',
          ...lines,
        ].join('\n')
      }

      // Build Freqtrade bot status + entry/exit stats block
      let freqtradeBlock = ''
      if (ftData) {
        const parts: string[] = []

        // Health status (ping + last process check)
        if (ftData.health) {
          const h = ftData.health
          const icon = h.status === 'ok' ? '✅' : h.status === 'degraded' ? '⚠️' : '🔴'
          parts.push(
            '',
            '--- FREQTRADE HEALTH ---',
            `${icon} Status: ${h.status.toUpperCase()} — ${h.details}`,
          )
        }

        // Bot config summary
        if (ftData.botConfig) {
          const cfg = ftData.botConfig
          const openCount = positions?.positions?.length ?? 0
          parts.push(
            '',
            '--- FREQTRADE BOT STATUS ---',
            `Strategy: ${cfg.strategy || 'unknown'} | Timeframe: ${cfg.timeframe || '?'} | Mode: ${cfg.trading_mode || 'spot'} | Stoploss: ${cfg.stoploss != null ? (cfg.stoploss * 100).toFixed(1) + '%' : '?'}`,
            `Max Open Trades: ${cfg.max_open_trades ?? '?'} (current: ${openCount}) | State: ${cfg.state || 'running'} | Dry Run: ${cfg.dry_run}`,
          )
        }

        // Entry tag performance
        if (ftData.entryStats && Array.isArray(ftData.entryStats)) {
          parts.push('', '--- ENTRY SIGNAL PERFORMANCE ---')
          for (const tag of ftData.entryStats) {
            const winRate = tag.trades > 0 ? ((tag.wins / tag.trades) * 100).toFixed(0) : '0'
            const flag = tag.trades >= 10 && (tag.wins / tag.trades) < 0.4 ? ' ← UNDERPERFORMING' : ''
            parts.push(
              `Tag "${tag.enter_tag}": ${tag.trades} trades, ${tag.wins} wins, winRate=${winRate}%, avgProfit=${tag.profit_mean != null ? (tag.profit_mean > 0 ? '+' : '') + (tag.profit_mean * 100).toFixed(1) + '%' : 'N/A'}${flag}`
            )
          }
        }

        // Exit reason distribution
        if (ftData.exitStats && Array.isArray(ftData.exitStats)) {
          const totalExits = ftData.exitStats.reduce((s: number, e: any) => s + (e.trades || 0), 0)
          parts.push('', '--- EXIT REASON DISTRIBUTION ---')
          for (const reason of ftData.exitStats) {
            const pct = totalExits > 0 ? ((reason.trades / totalExits) * 100).toFixed(0) : '0'
            parts.push(
              `${reason.exit_reason}: ${reason.trades} trades (${pct}%), avg profit=${reason.profit_mean != null ? (reason.profit_mean > 0 ? '+' : '') + (reason.profit_mean * 100).toFixed(1) + '%' : 'N/A'}`
            )
          }
        }

        // Pending orders
        parts.push('', '--- PENDING ORDERS ---')
        if (ftData.pendingOrders && ftData.pendingOrders.length > 0) {
          for (const order of ftData.pendingOrders) {
            const age = order.createdAt ? `(placed ${Math.round((Date.now() - new Date(order.createdAt).getTime()) / 60000)}m ago)` : ''
            parts.push(`${order.symbol}: ${order.side} ${order.type} ${order.size} @ $${order.price ?? 'market'} ${age}`)
          }
        } else {
          parts.push('(no pending orders)')
        }

        freqtradeBlock = parts.join('\n')
      }

      liveDataBlock = [
        '',
        '--- LIVE TRADING DATA (pre-fetched, current as of this heartbeat) ---',
        '',
        '## Account',
        JSON.stringify(account, null, 2),
        '',
        '## Open Positions',
        positions?.positions?.length > 0
          ? JSON.stringify(positions.positions, null, 2)
          : '(no open positions)',
        '',
        '## Funding Rates (held positions)',
        Object.keys(funding).length > 0
          ? JSON.stringify(funding, null, 2)
          : '(none)',
        freqtradeBlock,
        regimeBlock,
        strategyBlock,
        statsBlock,
        '',
        '--- END LIVE DATA ---',
      ].join('\n')
    } catch (err) {
      liveDataBlock = '\n(Live data pre-fetch failed — call tools manually)\n'
    }

    // Read HEARTBEAT.md content upfront so we can inject it into the prompt
    // (the AI has no file-reading tool, so we must provide the content directly)
    const heartbeatContent = await readHeartbeatFile(heartbeatFilePath)

    // Build prompt — cron/exec events get a dedicated prompt instead of the heartbeat one
    const hasCronEvents = systemEvents.some((e) => e.source === 'cron')
    let fullPrompt: string

    if (hasCronEvents) {
      // Cron events: build a purpose-built prompt so the agent relays the reminder
      const eventLines = systemEvents.map((evt) => `- ${evt.text}`)
      fullPrompt = [
        'A scheduled reminder has been triggered. The reminder content is shown below.',
        'Please relay this reminder to the user in a helpful and friendly way.',
        'Do NOT reply with HEARTBEAT_OK — this is a cron event that must be delivered.',
        '',
        ...eventLines,
        liveDataBlock,
      ].join('\n')
    } else if (systemEvents.length > 0) {
      // Other system events (exec, etc.): append to heartbeat prompt with file content
      const parts: string[] = []
      if (heartbeatContent) {
        parts.push('Here is the current HEARTBEAT.md content:', '', heartbeatContent, '')
      }
      parts.push('--- System Events ---')
      for (const evt of systemEvents) {
        parts.push(`[${evt.source}] ${evt.text}`)
      }
      parts.push(liveDataBlock)
      parts.push('', 'Check the above and act on anything that needs attention. Reply HEARTBEAT_OK if nothing to report.')
      fullPrompt = parts.join('\n')
    } else {
      // Regular heartbeat: inject file content + live data directly into prompt
      if (heartbeatContent) {
        fullPrompt = [
          'Here is the current HEARTBEAT.md content:',
          '',
          heartbeatContent,
          liveDataBlock,
          '',
          'Check if anything needs attention based on the above instructions and live data. The trading data above is ALREADY FRESH — do NOT call cryptoGetPositions/cryptoGetAccount again unless you need to refresh mid-analysis. Reply HEARTBEAT_OK if nothing to report.',
        ].join('\n')
      } else {
        fullPrompt = prompt + liveDataBlock
      }
    }

    // Stateless call — no session accumulation, fresh every time
    const result = await engine.ask(fullPrompt)

    // Strip ack token to decide if the response should be delivered.
    // Cron events bypass the ack check — they must always be delivered.
    const { shouldSkip, text } = stripAckToken(
      result.text,
      config.scheduler.heartbeat.ackToken,
      config.scheduler.heartbeat.ackMaxChars,
    )

    if (shouldSkip && !hasCronEvents) {
      return { status: 'ok-ack', text }
    }

    if (!text.trim()) {
      return { status: 'ok-empty' }
    }

    // --- Guard 3: dedup ---
    // Suppress identical alert text within window
    if (heartbeatDedup.isDuplicate(text)) {
      console.log('scheduler: duplicate heartbeat response suppressed')
      return { status: 'skipped', reason: 'duplicate' }
    }

    // Resolve delivery target (last-interacted channel)
    const target = resolveDeliveryTarget()
    if (!target) {
      console.warn('scheduler: no delivery target available, response dropped')
      return { status: 'skipped', reason: 'no-delivery-target', text }
    }

    // Persist to delivery queue first, then attempt immediate delivery
    const deliveryConfig = config.scheduler.delivery
    const entryId = await enqueue(deliveryConfig, {
      channel: target.channel,
      to: target.to,
      text,
    })

    try {
      await target.deliver(text)
      await ack(deliveryConfig, entryId)
      heartbeatDedup.record(text)
      emit('delivery', { status: 'sent', channel: target.channel, to: target.to })
      return { status: 'sent', text }
    } catch (err) {
      console.error('scheduler: delivery failed, queued for retry:', err)
      emit('delivery', { status: 'failed', channel: target.channel, error: String(err) })
      return { status: 'sent', text, reason: 'queued-for-retry' }
    }
  }

  // Create scheduler (timers start immediately if heartbeat enabled)
  let scheduler: Scheduler | null = null
  if (config.scheduler.heartbeat.enabled) {
    scheduler = createScheduler(
      { heartbeat: config.scheduler.heartbeat },
      runOnce,
    )
    console.log(`scheduler: heartbeat enabled (every ${config.scheduler.heartbeat.every})`)
  }

  if (cronEngine) {
    console.log('scheduler: cron enabled')
  }

  // ==================== Post-Plugin Init ====================
  // Plugins are started → connectors are registered → safe to start cron & recovery

  // Start cron engine (loads jobs from disk, arms timers)
  if (cronEngine) {
    await cronEngine.start()

    // Auto-create daily-pnl cron job if it doesn't exist
    const existingJobs = await cronEngine.list()
    const hasDailyPnl = existingJobs.some(j => j.name === 'daily-pnl')
    if (!hasDailyPnl) {
      await cronEngine.add({
        name: 'daily-pnl',
        schedule: { kind: 'cron', cron: '0 0 * * *' },  // UTC 00:00 daily
        payload: 'Run the daily P&L report now. Call cryptoGetAccount, cryptoGetPositions, and getSignalHistory(statsOnly=true). Also call cryptoGetOrders to get closed trades and run syncSignalOutcomes. Summarize all data and send to user.',
        sessionTarget: 'main',
        enabled: true,
      })
      console.log('scheduler: auto-created daily-pnl cron job (UTC 00:00)')
    }
  }

  // Recover any pending deliveries from previous runs (fire-and-forget)
  recoverPending({
    config: config.scheduler.delivery,
    deliver: async (entry) => {
      const target = resolveDeliveryTarget()
      if (!target) throw new Error('no delivery target')
      await target.deliver(entry.text)
    },
    log: { info: console.log, warn: console.warn },
  }).catch((err) => console.error('delivery recovery error:', err))

  // ==================== Shutdown ====================

  let stopped = false
  const shutdown = async () => {
    stopped = true
    scheduler?.stop()
    cronEngine?.stop()
    for (const plugin of plugins) {
      await plugin.stop()
    }
    await cryptoResult?.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // ==================== Tick Loop ====================

  console.log('engine: started')
  while (!stopped) {
    sandbox.setPlayheadTime(new Date())
    await sleep(config.engine.interval)
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
