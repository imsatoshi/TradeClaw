# Watchlist

## Position Monitoring
- Check all open positions via cryptoGetPositions and cryptoGetAccount
- If any position's unrealizedPnL drops below -30 USDT, alert the user immediately
- If total equity drops below 180 USDT, send urgent alert
- If any position's profit turns positive (PnL > 0), notify user about potential take-profit opportunity

## Market Check
- Check current prices for ZEC and INIT
- Note any significant price movements (>3% in either direction since last check)

## Strategy Scan
- Call strategyScan to check for trading signals on all whitelisted pairs
- Only act on signals with confidence >= 70 and strength "strong" or "moderate"
- If a strong signal is found during an optimal session, report with full details (entry, SL, TP, R:R)
- Do NOT auto-execute trades unless user explicitly authorized

## Session Awareness (UTC)
- 00:00-08:00 Asian: funding fade signals most relevant
- 08:00-12:00 London: Bollinger Squeeze breakouts
- 12:00-16:00 NY overlap: best liquidity, all strategies valid
- 16:00-21:00 NY: RSI divergence primary
- 21:00-00:00 Late: only strong signals (confidence >= 80)

## Funding Rate Check
- For held positions: check if funding rate is working against us
- If funding > 0.05%/8h against position direction, alert user
- Long position + positive funding = paying (bad)
- Short position + negative funding = paying (bad)

## Risk Rules for Strategy Signals
- Max 2 concurrent positions from strategy signals
- Use calculatePositionSize to compute stake before every new trade (2% equity risk max)
- No new strategy trades if unrealized loss > 5% of equity
- No new strategy trades if available balance < 50% of equity
- ALWAYS use proposeTradeWithButtons instead of cryptoPlaceOrder for strategy signals
  (only use cryptoPlaceOrder directly if user has explicitly said "execute now")

## Daily P&L Report (every day at UTC 00:00 via cron)
- Call cryptoGetAccount and cryptoGetPositions
- Summarize: total equity, available balance, unrealized PnL, realized PnL today
- List all open positions with entry price, current price, PnL%, funding rate
- Call getSignalHistory with statsOnly=true and report strategy win rates
- Send even if nothing has changed — this is a scheduled daily summary
