# Open Alice

File-driven trading Agent engine. Part of the OpenAlice ecosystem.

## Philosophy

**File-Driven Agent** — 当前的大模型天然擅长读写代码，而文件编辑本质上是写代码的变体。构建 file-driven 的 Agent 能最大程度发挥模型在 vibe trading 场景下的能力，同时降低 AI 理解问题和用户上手的门槛。所有状态（会话、配置、日志）都以文件形式存储，无需数据库。

**Architecture lineage** — 架构灵感来自 OpenClaw（浏览器自动化）和 Alice Agent（我司产品）。当前版本直接将 OpenClaw 工程嫁接进来（`src/openclaw/`），通过适配层屏蔽不支持的方法。`src/openclaw/` 是 OpenClaw 代码的平行副本，**如无必要不要修改**，未来会逐步吸收重构。

## Quick Start

```bash
pnpm install
cp .env.example .env   # Fill in secrets
npm run dev             # Dev mode (tsx watch)
npm run build           # Build → dist/ (tsup)
npm run test            # Vitest
```

## Project Structure

```
src/
├── main.ts                         # Entry point
├── core/
│   ├── engine.ts                   # Engine — central orchestrator
│   ├── types.ts                    # Plugin, EngineContext, EngineControl interfaces
│   ├── session.ts                  # SessionStore (JSONL, Claude Code compatible)
│   ├── compaction.ts               # Session compaction (auto-summarize long histories)
│   ├── config.ts                   # Config loading (Zod)
│   └── ai-config.ts               # AI provider selection (Vercel / Claude Code)
├── extension/
│   ├── analysis-kit/               # Market analysis extension
│   │   ├── adapter.ts              # Tool factory
│   │   ├── sandbox/Sandbox.ts      # Data access with playhead time isolation
│   │   ├── data/                   # Providers: Real/Mock MarketData, News, DotApiClient
│   │   └── tools/                  # calculate, calculateIndicator, indicators/
│   ├── trading/                    # Trading execution extension
│   │   ├── adapter.ts              # Tool factory
│   │   ├── interfaces.ts           # ITradingEngine, Position, Order, ALLOWED_SYMBOLS
│   │   └── wallet/                 # Git-like wallet (add → commit → push)
│   └── browser/                    # OpenClaw browser tool bridge
│       └── adapter.ts
├── plugins/
│   ├── http.ts                     # REST API (/health, /status)
│   └── mcp.ts                      # MCP protocol server (Hono)
├── connectors/
│   └── telegram/                   # Telegram bot (polling, per-user sessions)
├── providers/
│   ├── vercel-ai-sdk/              # ToolLoopAgent wrapper (default)
│   └── claude-code/                # Claude Code CLI integration (alternative)
└── openclaw/                       # ⚠️ OpenClaw parasitic codebase — DO NOT MODIFY
```

## Key Concepts

### Engine

Central orchestrator (`src/core/engine.ts`). Combines model + sandbox + wallet into a ToolLoopAgent (Vercel AI SDK, max 20 steps). Two query modes:
- `ask(prompt)` — stateless, no history
- `askWithSession(prompt, session)` — loads JSONL history, runs compaction if needed, appends result

Runs a tick loop (`config.interval` ms) advancing sandbox playhead time.

### Session (JSONL)

`SessionStore` (`src/core/session.ts`) persists conversations as JSONL in `data/sessions/`. Format is compatible with Claude Code CLI:

```jsonl
{"type":"user","message":{"role":"user","content":"..."},"uuid":"...","parentUuid":"...","sessionId":"...","timestamp":"..."}
{"type":"assistant","message":{"role":"assistant","content":[...]},...}
{"type":"system","subtype":"compact_boundary","compactMetadata":{...},...}
```

Compaction: when context grows too long, engine auto-summarizes older entries and inserts a `compact_boundary`. Only entries after the boundary (the "active window") are loaded via `readActive()`.

### Sandbox

Data access layer (`src/extension/analysis-kit/sandbox/Sandbox.ts`). Maintains `playheadTime` — all queries are time-isolated to `<= playheadTime`. Provides:
- Market data (OHLCV K-lines)
- News (glob/grep/read pattern, like filesystem)
- Frontal lobe (agent memory across rounds)

### Wallet (Git-like)

Trading operation tracker (`src/extension/trading/wallet/Wallet.ts`). Three-stage workflow:
1. **add()** — stage operations (placeOrder, closePosition, cancelOrder, adjustLeverage)
2. **commit(message)** — attach explanation, generate 8-char SHA-256 hash
3. **push()** — execute via trading engine, record results + state snapshot

Query: `log()`, `show(hash)`, `status()`, `simulatePriceChange()`.

### Plugin System

Interface: `{ name, start(ctx: EngineContext), stop() }`. Built-in plugins:
- **HttpPlugin** — REST endpoints on `config.port`
- **McpPlugin** — MCP protocol server on `config.mcpPort` (stateless, Hono-based)
- **TelegramPlugin** — bot connector (polling, dual-provider support)

### Tool System

All AI capabilities are explicit tools, created by adapter functions in each extension:
- `createAnalysisTools(sandbox)` — market data, news, indicators (SMA/EMA/RSI/BBANDS/MACD/ATR), cognition (think/plan/frontalLobe), calculate, reportWarning, getConfirm
- `createTradingTools(tradingEngine, wallet)` — orders, positions, account, wallet ops
- `createBrowserTools()` — single `browser` tool wrapping OpenClaw (16 actions)

## Configuration

**config.json**:
```json
{
  "pairs": ["BTC/USD", "ETH/USD", ...],
  "interval": 5000,
  "port": 3000,
  "mcpPort": 3001,
  "timeframe": "1h"
}
```

**.env**:
```
EXCHANGE_API_KEY=...
EXCHANGE_API_SECRET=...
TELEGRAM_BOT_TOKEN=...       # Optional
TELEGRAM_CHAT_ID=1234,5678   # Optional, comma-separated
```

Allowed symbols: `BTC/USD, ETH/USD, SOL/USD, BNB/USD, APT/USD, SUI/USD, HYPE/USD, DOGE/USD, XRP/USD`

## Conventions

- ESM only (`"type": "module"`, `.js` extensions in imports)
- Path alias: `@/*` → `./src/*`
- Strict TypeScript, ES2023 target
- Zod for config validation, TypeBox for tool parameter schemas
- `decimal.js` for financial math
- Pino logger → `logs/engine.log`

## Current Status

- Trading engine **not yet wired** — `main.ts` has TODO stubs
- Market data refreshes every 5 min via DotAPI
- Telegram supports dual providers (Vercel AI SDK / Claude Code CLI, switchable via `/settings`)
- `src/openclaw/` is a parasitic copy of the OpenClaw codebase — treat as read-only
