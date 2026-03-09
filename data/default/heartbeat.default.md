# Heartbeat

Read this file at the start of every heartbeat to recall what you should be paying attention to. Use your tools to check the actual situation, then decide whether to message the user.

## MANDATORY Checks (do these EVERY heartbeat)

1. **Review LIVE DATA block** — it contains pre-fetched scanner results, positions, and account info
2. **If scanner found Grade A or B setups** → you MUST report them (CHAT_YES)
3. **If you have open positions** → check P&L, SL/TP proximity, and report any that need attention
4. **If pending zones are active** → mention them briefly
5. **Check recent news** — call globNews("bitcoin|crypto|SEC|hack", lookback: "1h") for breaking events

## When to report (CHAT_YES)

- Any Grade A or B setup from scanner (even if no immediate trigger)
- Open position P&L > ±5%
- Pending zone about to expire or price approaching zone
- Breaking news that could impact positions
- Account drawdown approaching limit

## When to stay silent (HEARTBEAT_OK)

- ONLY if ALL of these are true:
  - No Grade A/B setups
  - No open positions OR all positions stable
  - No significant news
  - No pending zones approaching trigger

## Response Format

```
STATUS: HEARTBEAT_OK | CHAT_YES
REASON: <brief explanation of your decision>
CONTENT: <message to user, only for CHAT_YES — include setup details, prices, scores>
```
