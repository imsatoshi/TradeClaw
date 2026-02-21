# Watchlist

## Position Monitoring
- Check all open positions via cryptoGetPositions and cryptoGetAccount
- If any position's unrealizedPnL drops below -30 USDT, alert the user immediately
- If total equity drops below 180 USDT, send urgent alert
- If any position's profit turns positive (PnL > 0), notify user about potential take-profit opportunity

## Market Check
- Check current prices for ZEC and INIT
- Note any significant price movements (>3% in either direction since last check)

## Market Regime (4H Trend Context)
- MARKET REGIME is AUTO-INJECTED in LIVE DATA above (4H EMA9/21/55 trend detection)
- Each pair is classified as DOWNTREND / UPTREND / RANGING
- Use regime as CONTEXT for evaluating strategy signals and NFI positions

## Strategy Signals (Supplementary Trade Ideas)
- Strategy signals are AUTO-SCANNED and injected into LIVE DATA above every heartbeat
- Each signal is tagged with its regime context (e.g. [uptrend], [downtrend])
- Do NOT call strategyScan again — the data is already fresh
- Prefer signals that ALIGN with the regime:
  → LONG signals in UPTREND pairs = high conviction
  → SHORT signals in DOWNTREND pairs = high conviction
  → Signals AGAINST the regime = lower conviction, require higher confidence (>= 80)
- Use SIGNAL STATS to prioritize high win-rate strategies
- If a strong aligned signal is found, use proposeTradeWithButtons to propose the trade

## NFI Grinding Monitor
- NFI X7 uses grinding (DCA up to 20 layers) — this is its core profit mechanism, usually works fine
- Only alert when grinding gets extreme in a hostile regime:
  → grindCount >= 8 in DOWNTREND (long) or UPTREND (short): alert user, recommend review
  → grindCount >= 5 AND unrealizedPnL worsening over multiple heartbeats: flag to user
- Do NOT preemptively lock pairs just because of regime — NFI's grinding handles most situations
- Do NOT panic over grindCount 1-4, that's normal NFI operation

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

## NFI Strategy Analysis
- NFI entry tag performance and exit reason stats are AUTO-INJECTED in LIVE DATA above
- Use entry tag winRate to evaluate which NFI signals are working
- If a tag has winRate < 40% over 10+ trades, consider blacklisting pairs where it fires most
- Compare NFI tag stats with custom scanner stats for high-confidence trade decisions
- When both custom scanner AND NFI agree on direction, confidence is highest

## Pending Orders
- Pending limit orders (unfilled) are shown in LIVE DATA above
- Check if stale orders should be cancelled (older than 4 hours and far from market price)

## Position Risk Details
- Each position now includes stopLossPrice, stopLossDistance, and fundingFees
- If stoploss distance < 2%, alert user about tight stop
- If funding fees are negative and growing, evaluate whether to close the position

## Daily P&L Report (every day at UTC 00:00 via cron)
- Call cryptoGetAccount and cryptoGetPositions
- Summarize: total equity, available balance, unrealized PnL, realized PnL today
- List all open positions with entry price, current price, PnL%, funding rate
- Call getSignalHistory with statsOnly=true and report strategy win rates
- Send even if nothing has changed — this is a scheduled daily summary
