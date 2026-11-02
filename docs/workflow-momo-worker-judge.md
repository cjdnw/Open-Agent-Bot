# Momo → Worker → Judge Workflow (v0.2.0)

## Intent

Formalize the fleet pattern already used informally:

1. **Momo** (Chief of Staff) receives the user goal, decomposes work, and dispatches via `ask_bot`.
2. **Worker** bots execute scoped tasks (code, research, drafting) and return evidence.
3. **Judge** returns only `PASS` / `FAIL` / `BLOCKED` against fixed acceptance criteria.

## Logical Turn contract

- One user/Momo request is one **LogicalTurn**.
- Provider Fallback creates many **Attempts** under that LogicalTurn.
- `ask_bot` waits for LogicalTurn completion, not a single Attempt.
- Judge answers stay constrained even when F_final switches models.

## Out of scope for the v0.2.0 skeleton

- Inventing a second orchestration runtime beside the existing agents MCP.
- Weakening Judge output format when premium models are unavailable.
- Persisting Workflow runs across process restarts (see v0.3.0).
