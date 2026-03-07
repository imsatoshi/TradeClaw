# Freqtrade Provider for TradeClaw

This provider connects TradeClaw to a local [Freqtrade](https://www.freqtrade.io/) instance via its REST API, allowing TradeClaw to leverage Freqtrade's strategy execution, risk management, and position tracking while adding AI-driven decision making.

## Architecture

```
TradeClaw ──▶ FreqtradeTradingEngine ──▶ Freqtrade REST API ──▶ Exchange
```

## Setup

### 1. Configure Freqtrade REST API

Add the following to your Freqtrade `config.json`:

```json
{
  "api_server": {
    "enabled": true,
    "listen_ip_address": "127.0.0.1",
    "listen_port": 8080,
    "username": "alice",
    "password": "your-secure-password"
  }
}
```

### 2. Configure TradeClaw

Update `data/config/crypto.json`:

```json
{
  "provider": {
    "type": "freqtrade",
    "url": "http://localhost:8080",
    "username": "alice",
    "password": "your-secure-password",
    "defaultStakeAmount": 100
  }
}
```

**Note**: `allowedSymbols` is automatically synced from Freqtrade's whitelist. No need to configure it manually.

### 3. Start Freqtrade

```bash
freqtrade trade --config config.json
```

### 4. Start TradeClaw

```bash
pnpm dev
```

## Whitelist Synchronization

TradeClaw automatically syncs the trading pair whitelist from Freqtrade on startup:

1. On `init()`, TradeClaw calls Freqtrade's `/api/v1/whitelist` endpoint
2. The whitelist is synchronized to TradeClaw's global `CRYPTO_ALLOWED_SYMBOLS`
3. All subsequent operations use Freqtrade's whitelist for validation

This ensures consistency between Freqtrade's configuration and TradeClaw's symbol validation.

## Differences from CCXT Provider

| Feature | CCXT | Freqtrade |
|---------|------|-----------|
| Direct exchange connection | ✓ | ✗ (via Freqtrade) |
| Strategy backtesting | ✗ | ✓ |
| Built-in risk management | ✗ | ✓ |
| Position tracking | Basic | Advanced |
| Leverage adjustment | ✓ | ✗ (strategy-configured) |
| Order types | All CCXT types | Market/Limit/Stop |

## API Mapping

| TradeClaw | Freqtrade API |
|-----------|---------------|
| `placeOrder()` | `POST /api/v1/trade` |
| `getPositions()` | `GET /api/v1/status` (open trades) |
| `getOrders()` | `GET /api/v1/trades` |
| `getAccount()` | `GET /api/v1/balance` |
| `cancelOrder()` | `DELETE /api/v1/trade/{id}` |

## Additional Methods

The Freqtrade provider exposes additional methods not in the standard interface:

### `forceEnter(pair, side)`

Force Freqtrade to enter a position immediately (for AI signal execution):

```typescript
await engine.forceEnter('BTC/USDT', 'long');
```

### `forceExit(tradeId)`

Force exit a specific trade:

```typescript
await engine.forceExit('123');
```

## Usage with AI

When using Freqtrade provider, TradeClaw can:

1. **Query portfolio state**: Check open positions, balance, and performance
2. **Execute signals**: Use `forceEnter` for AI-generated entry signals
3. **Monitor trades**: Track status of open positions
4. **Risk management**: Review Freqtrade's stoploss and takeprofit settings

Example conversation:

```
User: 查看我的持仓
AI: [使用 cryptoGetPositions 工具查询 Freqtrade]

您当前有 2 个持仓：
1. BTC/USDT - 做多，数量 0.05，开仓价 $65,000，未实现盈亏 +$150
2. ETH/USDT - 做多，数量 0.5，开仓价 $3,200，未实现盈亏 -$50

User: BTC 达到了 70000，平仓一半
AI: [使用 cryptoClosePosition 工具部分平仓]

已提交平仓请求：BTC/USDT 平仓 50% (0.025 BTC)
```

## Limitations

1. **Leverage**: Cannot dynamically adjust leverage (set in Freqtrade strategy)
2. **Order types**: Limited to what Freqtrade supports
3. **Network**: Requires Freqtrade to be running and accessible
4. **Sync delay**: Position data may have slight delay compared to direct exchange

## Troubleshooting

### Connection refused
- Verify Freqtrade is running: `curl http://localhost:8080/api/v1/ping`
- Check `listen_ip_address` matches TradeClaw's network

### Authentication failed
- Verify username/password in both Freqtrade and TradeClaw config
- Check for URL encoding issues in password

### Orders rejected
- Verify trading pair is in Freqtrade's whitelist
- Check Freqtrade has sufficient balance
- Review Freqtrade logs for rejection reasons
