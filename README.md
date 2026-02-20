<p align="center">
  <img src="logo.png" alt="TradeClaw" width="128">
</p>

<h1 align="center">TradeClaw</h1>

<p align="center">AI 投资组合经理 — 管理算法策略的交易范围、监控风险、分析信号表现，24/7 守护你的投资组合。</p>

---

- **文件驱动** — Markdown 定义人格，JSON 定义配置，JSONL 存储对话。没有数据库、没有容器，只有文件。
- **推理驱动** — 每一个交易决策都基于持续推理和信号混合。
- **系统原生** — 可以与操作系统交互：浏览器搜索、Telegram 消息、本地设备连接。

## 功能

- **双 AI 引擎** — 运行时通过 Telegram `/settings` 切换 Claude Code CLI 和 Vercel AI SDK
- **灵活的模型后端** — 支持任何 OpenAI 兼容服务商（Anthropic、OpenAI、DeepSeek、Google 等）
- **加密货币交易** — CCXT（Bybit、OKX、Binance 等）或 [Freqtrade](https://www.freqtrade.io/) 策略机器人，AI 作为基金经理管理策略范围
- **证券交易** — Alpaca 美股集成，git 风格的钱包（stage、commit、push）
- **市场分析** — 技术指标（RSI、MACD、布林带等）、新闻搜索、价格模拟
- **A 股行情** — 东方财富免费 API，支持搜索股票、实时行情、K 线数据和技术指标计算（只分析，不交易）
- **认知状态** — 持久化的"大脑"，包含前额叶记忆、情绪追踪和提交历史
- **调度系统** — 心跳循环 + 定时任务，自动压缩上下文、去重、Transcript 修剪和消息投递队列
- **连接器** — Telegram 机器人、HTTP Webhook、MCP Server

## 架构

```mermaid
graph LR
  subgraph 服务商
    CC[Claude Code CLI]
    VS[Vercel AI SDK]
  end

  subgraph 核心
    E[Engine 引擎]
    S[Session 会话]
    SC[Scheduler 调度器]
  end

  subgraph 扩展
    AK[Analysis Kit 分析工具]
    AS[A-Share A股行情]
    CT[Crypto Trading 加密交易]
    ST[Securities Trading 证券交易]
    BR[Brain 大脑]
    BW[Browser 浏览器]
    CR[Cron 定时任务]
  end

  subgraph 连接器
    TG[Telegram]
    HTTP[HTTP API]
    MCP[MCP Server]
  end

  CC --> E
  VS --> E
  E --> S
  SC --> E
  AK --> E
  AS --> E
  CT --> E
  ST --> E
  BR --> E
  BW --> E
  CR --> E
  TG --> E
  HTTP --> E
  MCP --> E
```

**服务商** — 可互换的 AI 后端。Claude Code 以子进程方式启动 `claude -p`；Vercel AI SDK 在进程内运行 `ToolLoopAgent`，支持任何 OpenAI 兼容模型。

**核心** — `Engine` 管理 AI 对话，支持会话持久化（JSONL）和自动压缩。内置交易幻觉检测（模型声称交易但未调工具）和工具放弃检测（工具失败后模型拒绝重试）。`Scheduler` 驱动自主心跳/定时循环，使用 Transcript 修剪防止无用心跳污染会话上下文。

**扩展** — 按领域划分的工具集，注入到引擎中。每个扩展拥有自己的工具、状态和持久化逻辑。

**连接器** — 外部接口。Telegram 机器人用于聊天，HTTP 用于 Webhook，MCP Server 用于工具暴露。

## 快速开始

### 前置条件

- Node.js 20+
- pnpm 10+

### 安装

```bash
git clone https://github.com/imsatoshi/TradeClaw.git
cd TradeClaw
pnpm install
cp .env.example .env    # 然后填入你的 API 密钥
```

### AI 服务商

提供两种模式：

- **Vercel AI SDK**（默认）— 在进程内运行代理。在 `data/config/model.json` 中配置：

  ```json
  { "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
  ```

  也支持 OpenAI 兼容服务（DeepSeek、Kimi 等）：

  ```json
  { "provider": "openai", "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1" }
  ```

- **Claude Code** — 以子进程方式启动 `claude -p`，赋予代理完整的 Claude Code 能力。需要在宿主机上安装并认证 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。

### 加密货币交易

支持两种执行后端：

**CCXT（直连交易所）** — 连接任何 [CCXT 支持的交易所](https://docs.ccxt.com/)：

```bash
cp data/config/crypto.binance.example.json data/config/crypto.json
```

**Freqtrade（策略机器人）** — 通过 REST API 连接 [Freqtrade](https://www.freqtrade.io/) 实例。AI 作为**基金经理**管理策略：

```bash
cp data/config/crypto.freqtrade.example.json data/config/crypto.json
```

Freqtrade 模式下，AI 不直接下单，而是管理宏观层面：

| 工具 | 说明 |
|------|------|
| `cryptoManageBlacklist` | 黑名单管理 — 控制策略可以交易哪些币对 |
| `cryptoLockPair` | 临时锁定 — 短期暂停某个币对的交易（如高波动、突发新闻） |
| `cryptoGetStrategyStats` | 策略分析 — 按入场信号/退出原因查看胜率和收益 |
| `cryptoReloadConfig` | 重载配置 — 黑名单/白名单修改后刷新策略 |
| `cryptoGetPositions` | 持仓监控 — 显示 NFI 信号标签、DCA 次数、利润率 |
| `cryptoClosePosition` | 紧急平仓 — 仅用于黑天鹅等系统性风险 |
| `cryptoGetWhitelist` | 白名单查询 — 查看策略当前交易的币对列表 |

Freqtrade HTTP 请求内置自动重试（最多 2 次，间隔 1s），瞬态网络错误在引擎层消化，不会暴露给 AI 模型。

### 证券交易

基于 [Alpaca](https://alpaca.markets/)。支持模拟盘和实盘 — 在 `data/config/securities.json` 中切换。

### A 股行情分析

内置东方财富免费 API，**无需配置**，开箱即用。只做分析，不做交易。

提供 4 个 AI 工具：

| 工具 | 说明 | 示例 |
|------|------|------|
| `searchAShare` | 搜索股票（代码或中文名） | "搜索茅台" |
| `getAShareQuote` | 批量实时行情 | "看看 600519 和 000858 的行情" |
| `getAShareKline` | K 线数据（日/周/月/分钟线） | "给我贵州茅台最近 60 天的日 K" |
| `calculateAShareIndicator` | 技术指标计算 | "算一下茅台的 RSI" |

支持的技术指标：SMA、EMA、RSI、MACD、BBANDS、ATR、STDEV 等，复用 Analysis Kit 的计算引擎。

### 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `OPENAI_API_KEY` | OpenAI 兼容 API 密钥（DeepSeek、Kimi 等） |
| `OPENAI_BASE_URL` | OpenAI 兼容服务的自定义端点 |
| `EXCHANGE_API_KEY` | 交易所 API 密钥（CCXT 模式） |
| `EXCHANGE_API_SECRET` | 交易所 API Secret（CCXT 模式） |
| `EXCHANGE_PASSWORD` | 交易所口令（OKX 等） |
| `TELEGRAM_BOT_TOKEN` | Telegram 机器人 Token |
| `TELEGRAM_CHAT_ID` | 允许的聊天 ID，逗号分隔 |
| `ALPACA_API_KEY` | Alpaca 美股 API 密钥 |
| `ALPACA_SECRET_KEY` | Alpaca 美股 Secret 密钥 |

### 运行

```bash
pnpm dev        # 开发模式（热重载）
pnpm build      # 生产构建
pnpm test       # 运行测试
```

## 配置

所有配置位于 `data/config/`，JSON 格式 + Zod 校验。缺少的文件使用默认值。

| 文件 | 用途 |
|------|------|
| `engine.json` | 交易对、轮询间隔、HTTP/MCP 端口、时间框架 |
| `model.json` | AI 模型服务商、模型名称、可选 base URL |
| `agent.json` | 最大代理步数、Claude Code 允许/禁止的工具 |
| `crypto.json` | 加密交易 — CCXT（交易所、交易对）或 Freqtrade（URL、凭证） |
| `securities.json` | 证券交易、Alpaca 账户、模拟盘开关 |
| `compaction.json` | 上下文窗口限制、自动压缩阈值 |
| `scheduler.json` | 心跳间隔、定时任务开关、消息投递队列 |
| `persona.md` | 系统提示词人格（自由格式 Markdown） |

## 项目结构

```
src/
  main.ts                    # 组合根 — 连接所有模块
  core/                      # 引擎、会话、压缩、调度、定时、投递、幻觉/放弃检测
  providers/
    claude-code/             # Claude Code CLI 子进程封装
    vercel-ai-sdk/           # Vercel AI SDK ToolLoopAgent 封装
  extension/
    analysis-kit/            # 行情数据、指标计算、新闻、沙盒
    ashare/                  # A 股行情分析（东方财富 API）
    crypto-trading/          # 交易引擎工厂 + 钱包
      providers/
        ccxt/                # 直连交易所（CCXT）
        freqtrade/           # Freqtrade REST API 集成
    securities-trading/      # Alpaca 集成、钱包、工具
    brain/                   # 认知状态（记忆、情绪）
    browser/                 # 浏览器自动化桥接
    cron/                    # 定时任务管理工具
  connectors/
    telegram/                # Telegram 机器人（轮询、命令、设置）
  plugins/
    http.ts                  # HTTP Webhook 端点
    mcp.ts                   # MCP Server 工具暴露
data/
  config/                    # JSON 配置文件
  sessions/                  # JSONL 对话历史
  brain/                     # 代理记忆和情绪日志
  crypto-trading/            # 加密钱包提交历史
  securities-trading/        # 证券钱包提交历史
```

## 许可证

[MIT](LICENSE)
