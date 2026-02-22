# Heartbeat Response Rules

## DRY-RUN AWARENESS
Check system prompt for Trading Mode. If it says "DRY-RUN":
- Prefix ALL user-facing messages with **[PAPER]**
- Connection failures are NOT emergencies — no real money at risk
- Still track positions and signals normally for learning, but don't panic
- "Equity: N/A" in dry-run just means the system is reconnecting, reply HEARTBEAT_OK

## OUTPUT FORMAT (MANDATORY)
Keep response under 500 characters. Use this exact template:

[PAPER] (if dry-run)
💰 Equity: $X | Avail: $X | PnL: $X
📊 Positions: [symbol +/-X% TP/SL status] or (none)
⚠️ Alerts: [only if something needs attention]
🎯 Top Signal: [best 1 signal if aligned with regime] or (none)

## WHEN TO REPORT (exception-based)
Reply HEARTBEAT_OK if ALL true:
- No open positions OR all positions within normal range (-1.5% to +3%)
- No high-confidence regime-aligned signals (confidence >= 80)
- No funding rate warnings (> 0.05%/8h against position)
- Freqtrade health = OK (in dry-run, temporary disconnects count as OK)

## WHEN TO ACT
- Position loss > -1.5% → EXIT immediately (market order)
- Position profit > +2% → partial TP (close 50%)
- Regime shifted against position → EXIT
- Signal >= 80 confidence + regime aligned → proposeTradeWithButtons

## WHEN TO SEND DETAILED ALERT (break the 500 char limit)
- Position loss > -1% (approaching danger zone)
- Freqtrade DEGRADED or DOWN (live mode only — in dry-run, just note it)
- User explicitly asked for details in last message
