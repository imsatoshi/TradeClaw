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

## SCANNER REFERENCE (1H entry timeframe)
- Grade A signal: score >= 78
- Grade B signal: score >= 60
- Report BOTH Grade A and Grade B setups to user

## WHEN TO REPORT (CHAT_YES)
Report if ANY of the following is true:
- Any Grade A or Grade B setup exists (score >= 60)
- Open positions exist (report P&L status)
- Pending zones are active (mention briefly)
- Funding rate warnings (> 0.05%/8h against position)
- Freqtrade DEGRADED or DOWN (live mode only)

## WHEN TO STAY SILENT (HEARTBEAT_OK)
Reply HEARTBEAT_OK ONLY if ALL true:
- Zero qualified signals (no Grade A or B)
- No open positions
- No pending zones
- No funding rate concerns

## WHEN TO ACT
- Position loss > -1.5% → EXIT immediately (market order)
- Position profit > +2% → partial TP (close 50%)
- Regime shifted against position → EXIT
- Grade A signal (score >= 78) + regime aligned → proposeTradeWithButtons
- Grade B signal (score >= 60) → report to user for awareness

## WHEN TO SEND DETAILED ALERT (break the 500 char limit)
- Position loss > -1% (approaching danger zone)
- Freqtrade DEGRADED or DOWN (live mode only — in dry-run, just note it)
- User explicitly asked for details in last message
