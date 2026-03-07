import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { resolve } from 'path'
import { Engine } from './core/engine.js'
import { loadConfig } from './core/config.js'
import { setTradingMode, getModeTag } from './core/logger.js'
import type { Plugin, EngineContext, MediaAttachment } from './core/types.js'
import { HttpPlugin } from './plugins/http.js'
import { McpPlugin } from './plugins/mcp.js'
import { TelegramPlugin } from './connectors/telegram/index.js'
import { Sandbox, RealMarketDataProvider, fetchExchangeOHLCV, runStrategyScan, detectMarketRegime } from './extension/analysis-kit/index.js'
import { createAnalysisTools } from './extension/analysis-kit/index.js'
import { computeSignalStats, computeDetailedStats } from './extension/analysis-kit/tools/strategy-scanner/signal-log.js'
import type { DetailedSignalStats, StrategyWeight } from './extension/analysis-kit/tools/strategy-scanner/signal-log.js'
import { loadTradeMemory } from './extension/brain/TradeMemory.js'
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
import { sendTelegramMessage } from './connectors/telegram/telegram-api.js'
import { enqueue, ack, recoverPending } from './core/delivery.js'
import { emit } from './core/agent-events.js'
import { TradeManager } from './extension/crypto-trading/trade-manager/index.js'
import { FreqtradeTradingEngine } from './extension/crypto-trading/providers/freqtrade/FreqtradeTradingEngine.js'
import { ProviderRouter } from './core/ai-provider.js'
import { createAgent, VercelAIProvider } from './providers/vercel-ai-sdk/index.js'
import { ClaudeCodeProvider } from './providers/claude-code/index.js'
import { resolveCompactionConfig } from './core/compaction.js'
import { createEventLog } from './core/event-log.js'
import type { Heartbeat } from './task/heartbeat/index.js'
import { NewsCollectorStore, NewsCollector, createNewsArchiveTools } from './extension/news-collector/index.js'

const WALLET_FILE = resolve('data/crypto-trading/commit.json')
const BRAIN_FILE = resolve('data/brain/commit.json')
const FRONTAL_LOBE_FILE = resolve('data/brain/frontal-lobe.md')
const EMOTION_LOG_FILE = resolve('data/brain/emotion-log.md')
const PERSONA_DEFAULT_FILE = resolve('data/default/persona.default.md')
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

  // TradeManager: auto TP/SL lifecycle management
  let tradeManager: TradeManager | undefined
  if (cryptoResult && cryptoResult.engine instanceof FreqtradeTradingEngine) {
    tradeManager = new TradeManager(
      cryptoResult.engine,
      cryptoResult.directExchangeEngine,
      cryptoResult.isDryRun,
    )
    await tradeManager.start()
  }

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

  // Sandbox (data access — OHLCV from Binance exchange)
  let marketData: Record<string, import('./extension/archive-analysis/data/interfaces.js').MarketData[]> = {}
  try {
    marketData = await fetchExchangeOHLCV([...CRYPTO_ALLOWED_SYMBOLS], config.engine.timeframe)
    console.log(`market data: loaded ${Object.keys(marketData).length} pairs from Binance`)
  } catch (err) {
    console.warn('exchange OHLCV fetch failed (non-fatal, starting with empty data):', err)
  }

  const marketProvider = new RealMarketDataProvider(marketData)

  const sandbox = new Sandbox(
    { timeframe: config.engine.timeframe },
    marketProvider,
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
  // Persona layering: user override (data/config/persona.md) > default (data/default/persona.default.md)
  let persona = ''
  try { persona = await readFile(PERSONA_FILE, 'utf-8') } catch {
    try { persona = await readFile(PERSONA_DEFAULT_FILE, 'utf-8') } catch { /* use empty */ }
  }

  const frontalLobe = brain.getFrontalLobe()
  const emotion = brain.getEmotion().current
  const isDryRun = cryptoResult?.isDryRun ?? true  // default assume dry-run
  setTradingMode(isDryRun)

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
    `### Trading Mode: ${isDryRun ? '🧪 DRY-RUN (paper trading, no real money)' : '🔴 LIVE (real money)'}`,
    isDryRun ? 'All trades are simulated. When reporting to user, prefix messages with [PAPER].' : '',
    '',
    '## Trading System Architecture',
    '',
    'YOU are the strategy brain. TradeManager is your execution arm. Freqtrade is the order router.',
    '',
    '```',
    'AI (strategy decisions) → TradePlan (TP/SL specification) → TradeManager (auto-execution) → Freqtrade (exchange)',
    '```',
    '',
    '### How it works:',
    '- You place entry orders via cryptoPlaceOrder → commit → push',
    '- Then create a TradePlan (cryptoCreateTradePlan) with multi-level TP, SL, and optional trailing stop',
    '- TradeManager polls every 10s: detects entry fill → places TP1 → TP1 fills → places TP2 → etc.',
    '- Auto-breakeven (default ON): after TP1 fills, SL automatically moves to entry price — risk-free trade',
    '- Trailing stop (optional): SL follows price at a fixed distance/percentage as it moves in your favor',
    '- Live P&L is computed every tick: unrealized P&L, realized P&L, risk:reward ratio, max drawdown',
    '- You see all this in every heartbeat under "Active Trade Plans"',
    '- You can DYNAMICALLY ADJUST the plan at any time via cryptoUpdateTradePlan',
    '',
    '### Your capabilities:',
    '- Place orders (cryptoPlaceOrder) — open new positions',
    '- Create trade plans (cryptoCreateTradePlan) — set multi-level TP/SL, auto-managed',
    '- Update trade plans (cryptoUpdateTradePlan) — adjust TP targets, SL price, ratios, trailing stop, auto-breakeven',
    '- View trade plans (cryptoGetTradePlans) — check TP/SL execution status',
    '- Cancel trade plans (cryptoCancelTradePlan) — stop auto-management',
    '- Close positions (cryptoClosePosition) — emergency exit ONLY (bypasses TradePlan)',
    '- Manage universe (cryptoManageBlacklist) — control tradeable pairs',
    '- Lock pairs (cryptoLockPair) — temporarily suspend trading',
    '- Review strategy stats (cryptoGetStrategyStats) — evaluate signal performance',
    '- Query whitelist (cryptoGetWhitelist) — see tradeable pairs',
    '- Reload config (cryptoReloadConfig) — apply config changes',
    '',
    '### AI Trading Workflow (every heartbeat):',
    '',
    '**Step 1: Hybrid Analysis (Scanner + AI Judgment)**',
    '',
    '⚡ YOU ARE THE STRATEGY BRAIN — the scanner is your ASSISTANT, not your boss.',
    'The scanner provides quantitative scoring, but YOU make the final decision using raw market data.',
    '',
    '**Step 1a: Run strategyScan for quantitative pipeline scores**',
    '- Each symbol is scored on 8 dimensions (Trend, Momentum, Acceleration, Structure, Candle, Volume, Volatility, Funding)',
    '- Scanner now includes RAW indicator values in each dimension (rsi15m, macdHist, volumeRatio, etc.)',
    '- Use these raw values to form your own opinion — do not blindly follow the score',
    '',
    '**Step 1b: For Grade A/B setups, call getMarketContext to validate independently**',
    '- getMarketContext gives you multi-timeframe RSI, MACD, EMA alignment, BB position, ATR, key levels',
    '- Compare your independent reading of these indicators with the scanner\'s score',
    '- You have VETO POWER: if you see something the scanner missed (e.g. bearish divergence on 1h RSI, price at major resistance), you can DOWNGRADE or SKIP',
    '- You also have UPGRADE POWER: if scanner scores a Grade B but raw indicators show strong confluence, you can treat it as Grade A',
    '',
    '**Step 1c: Decision framework (AI-driven, scanner-assisted)**',
    '- Scanner Grade A (≥78) + your analysis agrees + ENTRY ✓ → propose via proposeTradeWithButtons',
    '- Scanner Grade A but your analysis disagrees → explain why and either skip or propose with strong caveats',
    '- Scanner Grade B (65-77 trend, 75-77 range) + your independent analysis sees strong confluence → upgrade to proposal',
    '- Scanner Grade B without your confirmation → monitor only',
    '- Scanner Grade C (below threshold) but you spot a clear pattern in raw data → mention it but be cautious',
    '- NOTE: Thresholds are DYNAMIC — if pipeline win rate drops below 45%, thresholds automatically increase',
    '- NOTE: Fresh regime penalty (-10pts) applied when regime changed within last 32 hours',
    '',
    '**Key AI judgment patterns to look for:**',
    '- Multi-timeframe RSI alignment (15m + 1h + 4h all pointing same direction = strong)',
    '- MACD histogram acceleration across timeframes',
    '- Price at BB extremes (position < 10 or > 90) with reversal candle = potential entry',
    '- Volume spike (ratio > 1.5) at key level = confirmation',
    '- EMA alignment (9 > 21 > 50 = strong trend) vs EMA compression (potential breakout)',
    '- ATR expansion vs contraction (volatility cycles)',
    '- Key level proximity: don\'t enter LONG right at swing high resistance',
    '',
    '- Position sizing scales with confidence: score 85 + R:R 2.5 → Kelly sizes at ~5% risk vs default 2%',
    '- Check [AI Judge Context] for historical win rates when available',
    ...(config.model.enableVision ? [
      '- Chart analysis (AI Vision):',
      '  → For Grade A/B setups with ENTRY ✓: call analyzeChart to validate price structure',
      '  → Use the chart to identify: key S/R near entry/SL/TP, chart patterns, volume confirmation',
      '  → If chart shows adverse pattern, downgrade or skip with explanation',
    ] : []),
    '- ALWAYS explain your reasoning in 2-3 sentences, referencing SPECIFIC indicator values',
    '  → Good: "BTC LONG: RSI 42 (recovering from oversold on 15m, 1h at 48 = room to run), MACD accelerating,',
    '     price bounced from BB lower at $94k, EMA9 crossing above EMA21. Scanner score 72 aligns with my read."',
    '  → Bad: "BTC has a Grade A setup, proposing trade."',
    '- For HELD positions: if getMarketContext shows reversal signals (RSI divergence, EMA cross against), tighten SL via proposeTradeWithButtons',
    '- The 3-tier TP system (TP1 40%, TP2 30%, TP3 trailing 30%) should be reflected in createTradePlan',
    '- For qualifying setups:',
    ...(config.model.enableVision
      ? ['  → strategyScan → getMarketContext → analyzeChart → your AI judgment → calculatePositionSize → proposeTradeWithButtons']
      : ['  → strategyScan → getMarketContext → your AI judgment → calculatePositionSize → proposeTradeWithButtons']),
    '',
    '**Step 2: Review active TradePlans** (from heartbeat "Active Trade Plans" section)',
    '- Check live P&L data: unrealized P&L, realized P&L, risk:reward ratio, max drawdown',
    '- For each plan, evaluate whether TP/SL levels are still appropriate given CURRENT market conditions',
    '- Auto-breakeven handles TP1→SL-to-entry automatically (no action needed)',
    '- If trailing stop is active, SL follows price automatically (no action needed for normal trailing)',
    '- Allowed autonomous adjustments (cryptoUpdateTradePlan ONLY):',
    '  → Tighten SL closer to current price (protective, never widen SL)',
    '  → Adjust trailing stop distance',
    '- ⛔ FORBIDDEN during heartbeat (requires user confirmation via proposeTradeWithButtons):',
    '  → Closing positions (cryptoClosePosition)',
    '  → Cancelling TradePlans (cryptoCancelTradePlan)',
    '  → Widening SL (moving SL further from current price)',
    '- If you believe a position should be closed, use proposeTradeWithButtons to ASK the user',
    '- The SL exists for a reason — let it do its job. Do NOT preempt the SL by closing manually.',
    '',
    '**Step 3: News Check (CRITICAL for risk management)**',
    '- Call globNews({ pattern: ".*", lookback: "1h", limit: 10 }) to scan recent headlines',
    '- If you find BREAKING NEWS affecting held positions or watchlist:',
    '  → Regulatory action (SEC, ban, lawsuit) → immediately tighten SL on affected positions',
    '  → Exchange hack/exploit → propose closing affected positions via proposeTradeWithButtons',
    '  → Major macro event (Fed, CPI, war) → evaluate portfolio-wide exposure',
    '  → Positive catalyst (ETF approval, partnership) → consider if it supports current positions',
    '- For held positions: search grepNews for the specific coin name to check recent sentiment',
    '- News sources: CoinDesk, CoinTelegraph, The Block, CNBC (auto-collected every 10 minutes)',
    '',
    '**Step 4: Housekeeping**',
    '- syncSignalOutcomes — update signal win-rate stats',
    '',
    '**Step 4: Learn from outcomes**',
    '- After syncSignalOutcomes, review any newly resolved signals',
    '- For each resolved signal: call tradeMemoryUpdate with a 1-sentence lesson',
    '- Lessons should be SPECIFIC and ACTIONABLE (not generic platitudes)',
    '  → Good: "SOL breakout_volume in Asian session lost 3 times — avoid low-volume hours"',
    '  → Bad: "Need better entry timing"',
    '- Check tradeMemoryQuery before proposing trades for relevant historical patterns',
    '',
    '### Position Management Philosophy:',
    '- You are a CALM strategist, not a panicked trader',
    '- Losses up to -5% are NORMAL for leveraged positions — do not overreact',
    '- Trust your TradePlan: the SL is the exit plan. Let it trigger naturally.',
    '- NEVER preempt the SL by closing a position manually — that defeats the purpose of the SL',
    '- Use LIVE P&L data (shown in heartbeat) to make informed decisions, not gut feelings',
    '- Adjust plans based on NEW INFORMATION (regime change, key level broken, news), not based on P&L fluctuations',
    '- When adjusting: tighten SL (cryptoUpdateTradePlan) — NEVER close directly',
    '- After TP1 fills: auto-breakeven moves SL to entry automatically (if enabled). Focus on TP2+ targets.',
    '- Use trailing stop for trending markets: let profits run while protecting gains',
    '',
    '### Risk Rules:',
    '- Every new trade MUST have a TradePlan with SL and at least 1 TP level',
    '- Position sizing: use Kelly Criterion — pass setupScore and riskReward to calculatePositionSize for dynamic risk (1-6% based on setup quality). Fallback: 2% flat risk if no score available.',
    '- Target SL: 1-3% from entry (based on ATR / market structure)',
    '- Target TP: 1.5-2.5x the SL distance (positive expectancy)',
    '- Max concurrent positions: Freqtrade max_open_trades (hard limit)',
    '- Max 40% of equity per single trade stake',
    '- No new trades if available balance < 30% of equity',
    '- ALWAYS use proposeTradeWithButtons for strategy signals (user must confirm)',
    '',
    '### Language:',
    '- ALWAYS respond in 中文 (Chinese). All analysis, status updates, trade proposals, and heartbeat reports must be in Chinese.',
    '- Technical terms (e.g. RSI, MACD, SL, TP, EMA) can remain in English, but explanations must be in Chinese.',
    '',
    '### Rules:',
    '- When the user asks you to buy/sell, DO IT: cryptoPlaceOrder → commit → push → cryptoCreateTradePlan',
    '- Full workflow: strategyScan → calculatePositionSize → proposeTradeWithButtons → (user confirms) → placeOrder → commit → push → createTradePlan',
    '- Use cryptoGetStrategyStats to evaluate which entry signals are working',
    '- Use cryptoManageBlacklist to remove underperforming pairs',
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
    '9. To open positions: use `cryptoPlaceOrder` → `cryptoWalletCommit` → `cryptoWalletPush`. All three steps required.',
    '10. After opening: ALWAYS create a TradePlan via `cryptoCreateTradePlan` with TP and SL levels.',
    '11. To adjust exits: use `cryptoUpdateTradePlan` to modify TP/SL. Do NOT use cryptoClosePosition for managed positions.',
    '12. NEVER respond with "order placed" or "order modified" unless you see a SUCCESS result from the tool.',
    '',
    '⛔⛔⛔ ABSOLUTE PROHIBITION — AUTONOMOUS POSITION CLOSING:',
    '13. You are FORBIDDEN from calling `cryptoClosePosition` or `cryptoCancelTradePlan` unless the USER EXPLICITLY ASKS you to close/cancel.',
    '14. During heartbeat: you may ONLY tighten SL via `cryptoUpdateTradePlan`. You MUST NOT close positions, cancel plans, or widen SL.',
    '15. If you believe a position should be closed (any reason: loss threshold, regime change, risk), you MUST use `proposeTradeWithButtons` to PROPOSE the close and WAIT for user confirmation.',
    '16. The SL is the automated exit. Let it trigger. Do NOT preempt it. "I think we should cut losses" is NOT a reason to close — it is a reason to TIGHTEN the SL.',
    '17. Violating rules 13-16 destroys user trust. The user sets the SL; only the user or the SL itself closes the position.',
    '',
    'CRITICAL RULES for technical analysis queries:',
    '14. You HAVE OHLCV K-line data for ALL whitelisted trading pairs (fetched from Binance exchange).',
    '15. When the user asks about RSI, MACD, moving averages, or any technical indicator, you MUST call `calculateIndicator` with the correct formula.',
    '16. NEVER say you lack market data or cannot calculate indicators. The data IS available — just call the tool.',
    '17. Example: for ZEC/USDT RSI, call calculateIndicator with formula "RSI(CLOSE(\'ZEC/USDT\', 50), 14)".',
    '',
    'CRITICAL RULES for tool failures:',
    '17. Tool failures are TRANSIENT. If a tool call returns an error, ALWAYS retry it at least once.',
    '18. NEVER tell the user "the system cannot do this" or suggest manual alternatives when a tool fails.',
    '19. NEVER refuse to call a tool based on previous failures in this conversation.',
    '20. Transient errors (network timeouts, API errors) are normal and expected. Retry is the correct response.',
    '',
    `### Freqtrade Whitelist (${CRYPTO_ALLOWED_SYMBOLS.length} tradeable pairs — ONLY these can be traded):`,
    `⚠️ ${[...CRYPTO_ALLOWED_SYMBOLS].join(', ')}`,
    'You MUST ONLY analyze and trade pairs from this list. Any pair NOT listed here will be rejected by the exchange.',
    '',
    'CRITICAL RULES for market overview:',
    '21. When the user asks about "行情" (market overview), "市场" (market), or wants a market scan, you MUST cover ALL whitelisted pairs above — not just mainstream coins.',
    '22. Call `strategyScan` WITHOUT the symbols parameter — it automatically scans ALL whitelisted pairs and returns signals sorted by confidence.',
    '23. For OHLCV/indicator analysis, call `getLatestOHLCV` or `calculateIndicator` with the full whitelist. Do NOT cherry-pick 5-10 coins.',
    '24. If the whitelist has 0 pairs shown above, call `getAllowedSymbols` or `cryptoGetWhitelist` to refresh.',
  ].join('\n')

  // Refresh market data periodically from Binance (news handled by RSS collector)
  setInterval(async () => {
    try {
      const freshData = await fetchExchangeOHLCV([...CRYPTO_ALLOWED_SYMBOLS], config.engine.timeframe)
      marketProvider.reload(freshData)
    } catch (err) {
      console.warn('market data refresh failed (non-fatal):', err)
    }
  }, config.engine.dataRefreshInterval)

  // ==================== News Collector ====================

  const newsStore = new NewsCollectorStore()
  await newsStore.init()

  const newsCollector = new NewsCollector({
    store: newsStore,
    feeds: [
      { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'coindesk' },
      { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', source: 'cointelegraph' },
      { name: 'The Block', url: 'https://www.theblock.co/rss.xml', source: 'theblock' },
      { name: 'CNBC Finance', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', source: 'cnbc' },
    ],
    intervalMs: 10 * 60 * 1000, // Every 10 minutes
  })
  newsCollector.start()
  console.log('news-collector: started (4 RSS feeds, every 10m)')

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
    ...createNewsArchiveTools(newsStore),
    ...createAShareTools(),
    ...createCryptoTradingTools(cryptoEngine, wallet, cryptoWalletStateBridge, cryptoResult?.directExchangeEngine, tradeManager),
    ...createBrainTools(brain),
    ...createBrowserTools(),
    ...(cronEngine ? createCronTools(cronEngine) : {}),
  }

  // ==================== Engine ====================

  const isAnthropic = config.model.provider === 'anthropic'

  // Create agent without instructions — VercelAIProvider injects system prompt
  // as a message to enable Anthropic prompt caching (cacheControl: ephemeral).
  const agent = createAgent(model, tools, undefined, config.agent.maxSteps)
  const compaction = resolveCompactionConfig(config.compaction, config.model.model)
  const vercelProvider = new VercelAIProvider(agent, compaction, instructions, isAnthropic)
  const claudeCodeProvider = new ClaudeCodeProvider(config.agent.claudeCode, compaction)
  const router = new ProviderRouter(vercelProvider, claudeCodeProvider)
  const engine = new Engine({ agent, tools, provider: router })

  // ==================== Plugins ====================

  const plugins: Plugin[] = [new HttpPlugin()]

  if (config.engine.mcpPort) {
    plugins.push(new McpPlugin(engine.tools, config.engine.mcpPort))
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    plugins.push(new TelegramPlugin({
      token: process.env.TELEGRAM_BOT_TOKEN,
      allowedChatIds: process.env.TELEGRAM_CHAT_ID
        ? process.env.TELEGRAM_CHAT_ID.split(',').map(Number)
        : [],
    }))
  }

  // Event log — persistent append-only event log used by web plugin + heartbeat
  const eventLog = await createEventLog()

  // Noop heartbeat stub (our scheduler handles heartbeat via core/scheduler.ts)
  const heartbeat: Heartbeat = {
    start: async () => {},
    stop: () => {},
    setEnabled: async () => {},
    isEnabled: () => config.scheduler.heartbeat.enabled,
  }

  // CronEngine is already created above (may be null if cron disabled)
  // Create a noop stub if null to satisfy EngineContext
  const cronEngineForCtx = cronEngine ?? createCronEngine({
    config: config.scheduler.cron,
    onWake: () => {},
  })

  const ctx: EngineContext = { config, engine, sandbox, cryptoEngine, eventLog, heartbeat, cronEngine: cronEngineForCtx as any }

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

    // Detailed data (stats, weights, memory, pair perf) only on cron/manual ticks — saves ~40% tokens on regular heartbeats
    const isDetailedTick = reason === 'cron' || reason === 'manual' || systemEvents.some(e => e.source === 'cron')

    // Pre-fetch live trading data + strategy scan — guaranteed fresh, no LLM dependency
    let liveDataBlock = ''
    try {
      // Fetch Freqtrade heartbeat data in parallel (entry/exit stats, bot config, pending orders)
      const ftDataPromise = 'getHeartbeatData' in cryptoEngine
        ? (cryptoEngine as any).getHeartbeatData().catch(() => null)
        : Promise.resolve(null)

      console.log('heartbeat: fetching live data...')
      const [positions, account, scanResult, signalStats, ftData, detailedStats, tradeMemory] = await Promise.all([
        (tools.cryptoGetPositions as any).execute({}),
        (tools.cryptoGetAccount as any).execute({}),
        runStrategyScan([...CRYPTO_ALLOWED_SYMBOLS]).catch((err: unknown) => {
          console.warn('heartbeat: strategy scan failed (non-fatal):', err)
          return null
        }),
        computeSignalStats().catch(() => null),
        ftDataPromise,
        computeDetailedStats().catch(() => null),
        loadTradeMemory().catch(() => null),
      ])
      console.log('heartbeat: live data fetched OK')

      // Reuse scanner's 4H data for regime detection (no extra Binance fetch)
      const ohlcv4h = scanResult?.ohlcv4h ?? {}
      const whitelistSymbols = [...CRYPTO_ALLOWED_SYMBOLS]
      const regimeResults = detectMarketRegime(whitelistSymbols, ohlcv4h)

      // Fetch funding rates for held positions
      const heldSymbols = Array.isArray(positions?.positions)
        ? positions.positions.map((p: any) => p.symbol)
        : []
      console.log('heartbeat: fetching funding rates for', heldSymbols.length, 'symbols')
      const funding = heldSymbols.length > 0
        ? await ((tools as Record<string, any>).cryptoGetFundingRate)?.execute({ symbols: heldSymbols }).catch((err: unknown) => {
          console.warn('heartbeat: funding rate fetch failed (non-fatal):', err)
          return {}
        })
        : {}
      console.log('heartbeat: funding rates OK')

      // Build market regime block — summary only (per-symbol regime is already in pipeline scores)
      let regimeBlock = ''
      if (regimeResults.length > 0) {
        const downCount = regimeResults.filter((r) => r.regime === 'downtrend').length
        const upCount = regimeResults.filter((r) => r.regime === 'uptrend').length
        const rangingCount = regimeResults.filter((r) => r.regime === 'ranging').length

        regimeBlock = [
          '',
          '--- MARKET REGIME (4H) ---',
          `${upCount} uptrend, ${downCount} downtrend, ${rangingCount} ranging (${regimeResults.length} pairs)`,
        ].join('\n')
      }

      // Build strategy signals block — multi-factor pipeline scores
      let strategyBlock = ''
      if (scanResult) {
        const session = scanResult.sessionInfo
        const parts: string[] = [
          '',
          `Session: ${session.sessionName} — ${session.note}`,
        ]

        // Pipeline setup scores (multi-factor scoring — replaces old confluence system)
        const pipeline = scanResult.pipelineSignals ?? []
        const qualified = pipeline.filter(s => s.grade !== 'C')
        const triggered = pipeline.filter(s => s.entry?.triggered)

        parts.push(
          '',
          '--- SETUP SCORES (multi-factor pipeline) ---',
          `Scored ${pipeline.length} setups across ${scanResult.symbols.length} symbols: ${qualified.length} qualified (Grade A/B), ${triggered.length} with entry trigger`,
        )

        if (pipeline.length > 0) {
          // Only show Grade A and B — C-grade adds tokens without aiding decisions
          const toShow = [
            ...pipeline.filter(s => s.grade === 'A'),
            ...pipeline.filter(s => s.grade === 'B'),
          ]

          for (let i = 0; i < toShow.length; i++) {
            const ps = toShow[i]
            const stars = ps.grade === 'A' ? '\u2605\u2605\u2605' : ps.grade === 'B' ? '\u2605\u2605' : '\u2605'
            const entryTag = ps.entry?.triggered ? 'ENTRY \u2713' : ps.grade !== 'C' ? 'ENTRY \u2717' : ''

            parts.push(
              `${i + 1}. ${stars} ${ps.symbol} ${ps.direction.toUpperCase()} [Grade ${ps.grade}, ${ps.regime}]: ${ps.setupScore}/100  ${entryTag}`,
            )

            // Dimension breakdown
            const d = ps.dimensions
            parts.push(
              `   Trend: ${d.trend.score}/${d.trend.max} (${d.trend.detail})`,
              `   Momentum: ${d.momentum.score}/${d.momentum.max} (${d.momentum.detail})`,
              `   Acceleration: ${d.acceleration.score}/${d.acceleration.max} (${d.acceleration.detail})`,
              `   Structure: ${d.structure.score}/${d.structure.max} (${d.structure.detail})`,
              `   Candle: ${d.candle.score}/${d.candle.max} (${d.candle.detail})`,
              `   Volume: ${d.volume.score}/${d.volume.max} (${d.volume.detail})`,
              `   Volatility: ${d.volatility.score}/${d.volatility.max} (${d.volatility.detail})`,
              `   Funding: ${d.funding.score}/${d.funding.max} (${d.funding.detail})`,
            )

            // Entry trigger details
            if (ps.entry?.triggered) {
              const e = ps.entry
              parts.push(
                `   \u2192 Entry $${e.entry.toFixed(4)} | SL $${e.stopLoss.toFixed(4)} | TP1 $${e.takeProfits.tp1.price.toFixed(4)} (${Math.round(e.takeProfits.tp1.ratio * 100)}%) | TP2 $${e.takeProfits.tp2.price.toFixed(4)} (${Math.round(e.takeProfits.tp2.ratio * 100)}%) | TP3 trailing (${Math.round(e.takeProfits.tp3.ratio * 100)}%) | R:R ${e.riskReward}`,
                `   Trigger: ${e.reason}`,
              )
            } else if (ps.grade !== 'C') {
              parts.push(`   \u2192 Waiting for 15m entry trigger`)
            }

            // AI Judge context: historical performance for this symbol
            if (detailedStats) {
              const symKey = `pipeline|${ps.symbol}`
              const regKey = `pipeline|${ps.regime}`
              const symStat = detailedStats.strategySymbol[symKey]
              const regStat = detailedStats.strategyRegime[regKey]
              if (symStat || regStat) {
                let ctx = '   [AI Judge Context]'
                if (symStat) ctx += ` ${ps.symbol}: ${symStat.winRate}% winRate (${symStat.wins + symStat.losses} trades)${symStat.lastOutcome ? `, last=${symStat.lastOutcome}` : ''}`
                if (regStat) ctx += ` | in ${ps.regime}: ${regStat.winRate}% winRate`
                parts.push(ctx)
              }
            }
          }
        } else {
          parts.push('(no setups scored — insufficient data)')
        }

        strategyBlock = parts.join('\n')
      }

      // Signal stats, strategy weights, trade memory — only on detailed ticks (changes slowly)
      let statsBlock = ''
      let weightsBlock = ''
      let memoryBlock = ''

      if (isDetailedTick) {
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

        const weights = scanResult?.strategyWeights
        if (weights && Object.keys(weights).length > 0) {
          const wLines = Object.values(weights).map((w: StrategyWeight) => {
            if (w.muted) return `${w.strategy}: MUTED (winRate=${Math.round(w.winRate * 100)}%, ${w.sampleSize} trades) ← AUTO-DISABLED`
            if (w.weight < 0.8) return `${w.strategy}: weight=${w.weight} (winRate=${Math.round(w.winRate * 100)}%, ${w.sampleSize} trades) ← UNDERWEIGHT`
            if (w.weight > 1.1) return `${w.strategy}: weight=${w.weight} (winRate=${Math.round(w.winRate * 100)}%, ${w.sampleSize} trades) ← BOOSTED`
            return `${w.strategy}: weight=${w.weight} (winRate=${Math.round(w.winRate * 100)}%, ${w.sampleSize} trades)`
          })
          weightsBlock = [
            '',
            '--- STRATEGY WEIGHTS (auto-adjusted by win rate) ---',
            ...wLines,
          ].join('\n')
        }

        if (tradeMemory && (tradeMemory.patterns.length > 0 || tradeMemory.recentLessons.length > 0)) {
          const mLines: string[] = []
          const topPatterns = [...tradeMemory.patterns]
            .sort((a, b) => b.samples - a.samples)
            .slice(0, 5)
          for (const p of topPatterns) {
            mLines.push(`- ${p.id}: ${p.winRate}% winRate (${p.samples} trades, avgPnl ${p.avgPnl > 0 ? '+' : ''}${p.avgPnl}%) — "${p.lesson}"`)
          }
          if (tradeMemory.recentLessons.length > 0) {
            mLines.push('Recent lessons:')
            for (const l of tradeMemory.recentLessons.slice(0, 5)) {
              mLines.push(`  - ${l}`)
            }
          }
          memoryBlock = ['', '--- TRADE MEMORY (learned patterns) ---', ...mLines].join('\n')
        }
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

        // Entry/exit stats — only on detailed ticks (cron/manual) to save tokens
        if (isDetailedTick) {
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

        // Daily P&L + pair performance — only on detailed ticks
        if (isDetailedTick) {
          if (ftData.dailyStats && ftData.dailyStats.data) {
            parts.push('', '--- DAILY P&L (last 7 days) ---')
            for (const day of ftData.dailyStats.data) {
              const pnl = day.abs_profit ?? 0
              const icon = pnl > 0 ? '📈' : pnl < 0 ? '📉' : '➖'
              parts.push(`${day.date}: ${icon} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (${day.trade_count ?? 0} trades)`)
            }
          }

          if (ftData.pairPerformance && Array.isArray(ftData.pairPerformance) && ftData.pairPerformance.length > 0) {
            const sorted = [...ftData.pairPerformance].sort((a: any, b: any) => (b.profit ?? 0) - (a.profit ?? 0))
            parts.push('', '--- PAIR PERFORMANCE (sorted by profit) ---')
            const top5 = sorted.slice(0, 5)
            const worst3 = sorted.slice(-3).reverse()
            for (const p of top5) {
              parts.push(`🟢 ${p.pair}: ${p.profit >= 0 ? '+' : ''}${p.profit?.toFixed(2) ?? '?'}% (${p.count ?? '?'} trades)`)
            }
            if (worst3.length > 0 && worst3[0] !== top5[top5.length - 1]) {
              parts.push('...')
              for (const p of worst3) {
                parts.push(`🔴 ${p.pair}: ${p.profit >= 0 ? '+' : ''}${p.profit?.toFixed(2) ?? '?'}% (${p.count ?? '?'} trades)`)
              }
            }
          }
        }

        freqtradeBlock = parts.join('\n')
      }

      // Build trade plans block
      const tradePlanBlock = tradeManager ? tradeManager.getSummaryForHeartbeat() : ''

      const modeLabel = isDryRun ? '🧪 DRY-RUN (paper trading)' : '🔴 LIVE (real money)'
      liveDataBlock = [
        '',
        `--- ${getModeTag()}LIVE TRADING DATA — ${modeLabel} ---`,
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
        tradePlanBlock,
        freqtradeBlock,
        regimeBlock,
        strategyBlock,
        statsBlock,
        weightsBlock,
        memoryBlock,
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
        'All live trading data is ALREADY provided below — do NOT call cryptoGetAccount/cryptoGetPositions/strategyScan again.',
        'Write a CONCISE report. Do NOT reply with HEARTBEAT_OK — this is a cron event that must be delivered.',
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
          '',
          'IMPORTANT: Keep your response under 500 characters unless there is an urgent alert. Use the compact template from HEARTBEAT.md. If nothing needs attention, reply HEARTBEAT_OK.',
        ].join('\n')
      } else {
        fullPrompt = prompt + liveDataBlock
      }
    }

    // Stateless call — no session accumulation, fresh every time
    console.log('heartbeat: calling engine.ask(), prompt length =', fullPrompt.length)
    const result = await engine.ask(fullPrompt)
    console.log('heartbeat: engine.ask() returned, text length =', result.text.length)

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
        payload: 'Daily P&L report. All live data is already provided below — do NOT call tools to re-fetch. Write a CONCISE summary (under 800 chars) covering: 1) account P&L one-liner, 2) open positions status (1 line each), 3) top risk alert if any. Skip tables, skip emoji spam, skip 7-day history.',
        sessionTarget: 'main',
        enabled: true,
      })
      console.log('scheduler: auto-created daily-pnl cron job (UTC 00:00)')
    }
  }

  // Post-startup WFO optimization — DISABLED
  // Reason: strategies had bugs (ema_trend EMA alignment, regime hard filter)
  // so all historical optimization data is invalid. Re-enable after collecting
  // clean data with fixed strategies (1-2 weeks).
  // See: batchOptimize() in analysis-kit for the implementation.

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
  let shutdownInProgress = false
  const shutdown = async (signal?: string) => {
    if (shutdownInProgress) return  // prevent double-shutdown
    shutdownInProgress = true
    console.log(`\nshutdown: ${signal ?? 'unknown'} received, cleaning up...`)
    stopped = true
    scheduler?.stop()
    cronEngine?.stop()
    tradeManager?.stop()
    for (const plugin of plugins) {
      try { await plugin.stop() } catch (err) { console.warn(`shutdown: ${plugin.name} stop error:`, err) }
    }
    await cryptoResult?.close()
    console.log('shutdown: complete')
    // Give a brief moment for port release before exit
    setTimeout(() => process.exit(0), 200)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

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
