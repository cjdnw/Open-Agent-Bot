# Quota routing, persistence, scheduling (v0.3.0)

## Quota-aware routing

- Read local quota snapshots (no secrets in tool output).
- Prefer candidates with remaining headroom before Fallback/F_final.
- Never expose API keys, tokens, or cookies through MCP or chat.

## Task persistence

- Persist LogicalTurn / Workflow run ids across Desktop restarts.
- Recover `busy` stuck state on boot from the turn ledger.

## Advanced scheduling

- Keep the daily quota collector (default 20:00 local).
- Allow Momo to query schedule health via readonly MCP tools.
