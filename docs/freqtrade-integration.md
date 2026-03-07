# OpenAlice + Freqtrade 集成指南

本文档记录如何将 OpenAlice 与 Freqtrade 集成，实现 AI 驱动的量化交易。

## 概述

**Freqtrade** 是一个开源的加密货币交易机器人，支持策略回测、风险管理和实盘交易。

**OpenAlice** 通过 Freqtrade 的 REST API 连接到 Freqtrade，将 AI 决策能力与 Freqtrade 的交易执行能力结合。

## 架构

```
┌─────────────┐     ┌──────────────────────────┐     ┌─────────────┐
│  Telegram   │────▶│   OpenAlice Engine       │────▶│  Freqtrade  │
│   用户      │     │  ┌────────────────────┐  │     │  REST API   │
│             │◀────│  │ FreqtradeTrading   │  │◀────│  (端口8989)  │
└─────────────┘     │  │ Engine             │  │     └─────────────┘
                    │  └────────────────────┘  │           │
                    └──────────────────────────┘           ▼
                                                          ┌─────────────┐
                                                          │  交易所      │
                                                          │ (Binance等) │
                                                          └─────────────┘
```

## 实现步骤

### 1. 创建 Freqtrade 提供者

创建 `src/extension/crypto-trading/providers/freqtrade/` 目录，包含：

#### 1.1 类型定义 (`types.ts`)

```typescript
// Freqtrade API 类型定义
export interface FreqtradeOrderRequest {
  pair: string;
  side: 'buy' | 'sell';
  amount?: number;
  price?: number;
  ordertype: 'market' | 'limit' | 'stop_loss' | 'stop_loss_limit';
}

export interface FreqtradeOrderResponse {
  order_id: string;
  pair: string;
  status: 'open' | 'closed' | 'canceled';
  amount: number;
  filled: number;
  price: number;
  side: 'buy' | 'sell';
}

export interface FreqtradeTrade {
  trade_id: number;
  pair: string;
  is_open: boolean;
  open_rate: number;
  close_rate?: number;
  amount: number;
  stake_amount: number;
  profit_ratio: number;
  profit_abs: number;
  open_date: string;
  close_date?: string;
  side: 'long' | 'short';
  leverage?: number;
  liquidation_price?: number;
}

export interface FreqtradeWhitelistResponse {
  whitelist: string[];
  method: string;
  length: number;
}

// ... 其他类型
```

#### 1.2 交易引擎实现 (`FreqtradeTradingEngine.ts`)

核心实现 `ICryptoTradingEngine` 接口：

```typescript
export class FreqtradeTradingEngine implements ICryptoTradingEngine {
  private config: FreqtradeEngineConfig;
  private authHeader: string;
  private initialized = false;

  constructor(config: FreqtradeEngineConfig) {
    this.config = config;
    this.authHeader = 'Basic ' + Buffer.from(
      `${config.username}:${config.password}`
    ).toString('base64');
  }

  async init(): Promise<void> {
    // 验证连接
    const status = await this.fetchStatus();

    // 同步白名单
    const whitelist = await this.fetchWhitelist();
    if (whitelist.length > 0) {
      initCryptoAllowedSymbols(whitelist);
    }

    this.initialized = true;
  }

  // 实现接口方法
  async placeOrder(order: CryptoPlaceOrderRequest): Promise<CryptoOrderResult>
  async getPositions(): Promise<CryptoPosition[]>
  async getOrders(): Promise<CryptoOrder[]>
  async getAccount(): Promise<CryptoAccountInfo>
  async cancelOrder(orderId: string): Promise<boolean>
  async adjustLeverage(symbol: string, leverage: number): Promise<...>

  // Freqtrade 特有方法
  async forceEnter(pair: string, side: 'long' | 'short'): Promise<...>
  async forceExit(tradeId: string): Promise<...>
  async fetchWhitelist(): Promise<string[]>
}
```

#### 1.3 代理问题处理

由于环境可能存在 HTTP 代理，需要临时禁用代理以直接连接 Freqtrade：

```typescript
let originalNoProxy: string | undefined;

private disableProxy(): void {
  originalNoProxy = process.env.NO_PROXY;
  process.env.NO_PROXY = '*';
}

private restoreProxy(): void {
  if (originalNoProxy !== undefined) {
    process.env.NO_PROXY = originalNoProxy;
  } else {
    delete process.env.NO_PROXY;
  }
}

private async get<T>(path: string): Promise<T> {
  this.disableProxy();
  try {
    const response = await fetch(url, {
      // ... headers
    });
    return response.json() as Promise<T>;
  } finally {
    this.restoreProxy();
  }
}
```

### 2. 更新配置系统

#### 2.1 修改 `src/core/config.ts`

在 `cryptoSchema` 中添加 `freqtrade` provider：

```typescript
const cryptoSchema = z.object({
  provider: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('ccxt'),
      exchange: z.string(),
      sandbox: z.boolean().default(false),
      // ...
    }),
    z.object({
      type: z.literal('freqtrade'),
      url: z.string().url(),
      username: z.string(),
      password: z.string(),
      defaultStakeAmount: z.number().optional(),
    }),
    z.object({
      type: z.literal('none'),
    }),
  ]).default({ type: 'none' }),
});
```

#### 2.2 更新工厂函数 `src/extension/crypto-trading/factory.ts`

```typescript
case 'freqtrade': {
  const engine = new FreqtradeTradingEngine({
    url: providerConfig.url,
    username: providerConfig.username,
    password: providerConfig.password,
    defaultStakeAmount: providerConfig.defaultStakeAmount,
  });

  await engine.init();

  return {
    engine,
    close: () => engine.close(),
  };
}
```

### 3. 配置 Freqtrade

在 Freqtrade 的 `config.json` 中启用 REST API：

```json
{
  "api_server": {
    "enabled": true,
    "listen_ip_address": "0.0.0.0",
    "listen_port": 8989,
    "username": "admin",
    "password": "your-secure-password",
    "jwt_secret_key": "somethingrandom",
    "ws_token": "somethingrandom"
  }
}
```

### 4. 配置 OpenAlice

创建 `data/config/crypto.json`：

```json
{
  "_comment": "Freqtrade 配置",
  "provider": {
    "type": "freqtrade",
    "url": "http://YOUR_FREQTRADE_HOST:8080",
    "username": "your-username",
    "password": "your-password",
    "defaultStakeAmount": 100
  }
}
```

**注意**：`allowedSymbols` 会自动从 Freqtrade 白名单同步，无需手动配置。

### 5. 启动脚本

创建 `start-with-freqtrade.sh` 处理代理问题：

```bash
#!/bin/bash

echo "==============================================="
echo "OpenAlice + Freqtrade Launcher"
echo "==============================================="

# 禁用代理以直接连接 Freqtrade
export NO_PROXY='*'
unset HTTP_PROXY
unset HTTPS_PROXY
unset http_proxy
unset https_proxy

echo "Freqtrade URL: http://YOUR_FREQTRADE_HOST:8080"
echo ""

pnpm dev
```

## API 映射

| OpenAlice 方法 | Freqtrade API | 说明 |
|---------------|---------------|------|
| `placeOrder()` | `POST /api/v1/trade` | 下单 |
| `getPositions()` | `GET /api/v1/status` | 获取持仓 |
| `getOrders()` | `GET /api/v1/trades` | 获取交易历史 |
| `getAccount()` | `GET /api/v1/balance` | 获取账户余额 |
| `cancelOrder()` | `DELETE /api/v1/trade/{id}` | 取消订单 |
| `forceEnter()` | `POST /api/v1/forceenter` | 强制开仓 |
| `forceExit()` | `POST /api/v1/forceexit` | 强制平仓 |
| `fetchWhitelist()` | `GET /api/v1/whitelist` | 获取白名单 |

## 白名单同步机制

启动时自动同步流程：

```
OpenAlice 启动
    └── FreqtradeTradingEngine.init()
        ├── GET /api/v1/ping (验证连接)
        ├── GET /api/v1/whitelist (获取白名单)
        │   └── 返回: ["INIT/USDT:USDT", "ZEC/USDT:USDT"]
        └── initCryptoAllowedSymbols(whitelist) (同步到全局)
```

所有后续交易操作都使用同步后的白名单进行验证。

## 使用示例

### 通过 Telegram 交互

```
用户: 查看我的持仓
AI: 正在查询 Freqtrade 持仓...

您当前有 2 个持仓：
1. INIT/USDT:USDT 做多
   - 数量: 1466
   - 开仓价: 0.11553
   - 未实现盈亏: -22.98 USDT

2. ZEC/USDT:USDT 做多
   - 数量: 0.659
   - 开仓价: 263.41
   - 未实现盈亏: +0.47 USDT

用户: 帮我平仓 INIT
AI: 正在执行平仓操作...

已提交平仓请求：INIT/USDT:USDT 全部平仓
```

### 程序化调用

```typescript
const engine = new FreqtradeTradingEngine({
  url: 'http://YOUR_FREQTRADE_HOST:8080',
  username: 'your-username',
  password: 'your-password',
});

await engine.init();

// 强制开仓（AI 信号执行）
await engine.forceEnter('BTC/USDT', 'long');

// 查询持仓
const positions = await engine.getPositions();
```

## 故障排除

### 连接被拒绝

```
Error: fetch failed - SocketError: other side closed
```

**原因**: 代理环境变量干扰

**解决**: 使用启动脚本或手动设置 `NO_PROXY='*'`

### 认证失败

```
Freqtrade API error 401: Unauthorized
```

**原因**: 用户名或密码错误

**解决**: 检查 Freqtrade 配置和 OpenAlice 配置是否一致

### 端口占用

```
Error: listen EADDRINUSE: address already in use :::13001
```

**解决**:
```bash
lsof -ti:13001 | xargs kill -9
```

## 文件清单

| 文件 | 说明 |
|------|------|
| `src/extension/crypto-trading/providers/freqtrade/types.ts` | API 类型定义 |
| `src/extension/crypto-trading/providers/freqtrade/FreqtradeTradingEngine.ts` | 引擎实现 |
| `src/extension/crypto-trading/providers/freqtrade/index.ts` | 导出 |
| `src/extension/crypto-trading/providers/freqtrade/README.md` | 详细文档 |
| `src/core/config.ts` | 配置 Schema |
| `src/extension/crypto-trading/factory.ts` | 工厂函数 |
| `data/config/crypto.json` | 配置文件 |
| `start-with-freqtrade.sh` | 启动脚本 |

## 参考

- [Freqtrade REST API 文档](https://www.freqtrade.io/en/stable/rest-api/)
- [OpenAlice 架构文档](./architecture.md)
