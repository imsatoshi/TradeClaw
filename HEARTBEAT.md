# Watchlist

## Position Monitoring
- Check all open positions via cryptoGetPositions and cryptoGetAccount
- If any position's unrealizedPnL drops below -30 USDT, alert the user immediately
- If total equity drops below 180 USDT, send urgent alert
- If any position's profit turns positive (PnL > 0), notify user about potential take-profit opportunity

## Market Check
- Check current prices for ZEC and INIT
- Note any significant price movements (>3% in either direction since last check)
