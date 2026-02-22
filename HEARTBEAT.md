# Heartbeat Response Rules

## OUTPUT FORMAT (MANDATORY)
Keep response under 500 characters. Use this exact template:

💰 Equity: $X | Avail: $X | PnL: $X
📊 Positions: [symbol +/-X% TP/SL status] or (none)
⚠️ Alerts: [only if something needs attention]
🎯 Top Signal: [best 1 signal if aligned with regime] or (none)

## WHEN TO REPORT (exception-based)
Reply HEARTBEAT_OK if ALL true:
- No open positions OR all positions within normal range (-1.5% to +3%)
- No high-confidence regime-aligned signals (confidence >= 80)
- No funding rate warnings (> 0.05%/8h against position)
- Freqtrade health = OK

## WHEN TO ACT
- Position loss > -1.5% → EXIT immediately (market order)
- Position profit > +2% → partial TP (close 50%)
- Regime shifted against position → EXIT
- Signal >= 80 confidence + regime aligned → proposeTradeWithButtons

## WHEN TO SEND DETAILED ALERT (break the 500 char limit)
- Position loss > -1% (approaching danger zone)
- Freqtrade DEGRADED or DOWN
- User explicitly asked for details in last message
