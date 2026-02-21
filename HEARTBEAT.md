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
- Strategy signals are AUTO-SCANNED and injected into the LIVE DATA section above every heartbeat
- Do NOT call strategyScan again — the data is already fresh
- Only act on signals with confidence >= 70 and strength "strong" or "moderate"
- Use SIGNAL STATS to prioritize high win-rate strategies
- If a strong signal is found during an optimal session, use proposeTradeWithButtons to propose the trade

## Session Awareness (UTC)
- 00:00-08:00 Asian: funding fade signals most relevant
- 08:00-12:00 London: good for breakout and trend signals
- 12:00-16:00 NY overlap: best liquidity, all strategies valid
- 16:00-21:00 NY: RSI divergence primary, trend continuation
- 21:00-00:00 Late: only strong signals (confidence >= 80)

## Funding Rate Check
- For held positions: check if funding rate is working against us
- If funding > 0.05%/8h against position direction, alert user
- Long position + positive funding = paying (bad)
- Short position + negative funding = paying (bad)
- Funding rate history is auto-saved on each cryptoGetFundingRate call. Use getFundingRateHistory to review trends.

## Risk Rules (ENFORCED IN CODE — cannot be bypassed)
- Max concurrent positions = Freqtrade max_open_trades (hard limit in operation-dispatcher)
- Max 40% of equity per single trade stake (hard limit)
- No new trades if available balance < 30% of equity (hard limit)
- Use calculatePositionSize for every new trade (2% equity risk max)
- ALWAYS use proposeTradeWithButtons for strategy signals (limit order, not market)

## Signal Outcome Sync
- Call cryptoGetOrders and filter for closed trades (is_open=false, has close_date)
- For each closed trade, extract: symbol, direction (is_short→'short', else→'long'), openDate, closeDate, closeRate, profitRatio
- Call syncSignalOutcomes with the closed trades to update signal win/loss stats
- Run this once per heartbeat (or at minimum during daily P&L report)

## Daily P&L Report (every day at UTC 00:00 via cron)
- Call cryptoGetAccount and cryptoGetPositions
- Summarize: total equity, available balance, unrealized PnL, realized PnL today
- List all open positions with entry price, current price, PnL%, funding rate
- Call getSignalHistory with statsOnly=true and report strategy win rates
- Send even if nothing has changed — this is a scheduled daily summary
