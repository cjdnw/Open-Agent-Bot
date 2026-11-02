# Dual-stage Judge + Momo Workflow (v0.4.0)

## Architecture

```text
User → Momo → Judge PRE_REVIEW → Momo PLAN (SELF|DELEGATE|ESCALATE)
     → EXECUTING → Judge FINAL_REVIEW → COMPLETED | REWORK | BLOCKED | FAILED
```

- **Judge** judges difficulty/risk/acceptance **before** work, and independently reviews **after**.
- **Momo** decides how to execute (self / delegate / escalate). Judge does not force staff assignment.
- Backend scheduler owns stage transitions. Momo must not `ask_bot` Judge or simulate PASS/FAIL.

## States

`CREATED → PRE_REVIEW → PLANNING → EXECUTING → FINAL_REVIEW → COMPLETED`

Also: `REWORK` (max 2), `BLOCKED`, `FAILED`, `CANCELLED`.

## Rules

1. No execution before successful PRE_REVIEW.
2. Locked `acceptanceCriteria` + `criteriaVersion` bind FINAL_REVIEW.
3. PASS must match current `artifactHash` (no stale PASS reuse).
4. HIGH risk / `requiresUserAuthorization` forces ESCALATE.
5. Judge unavailable → BLOCKED/FAILED, never auto-PASS.
6. Interrupt clears workflow busy (no permanent busy).

## UI

Momo chat shows:

1. Judge pre-review card / markdown
2. Momo decision
3. Execution / worker activity
4. Judge final PASS|FAIL|BLOCKED
5. Delivery or rework notes

Events are real `workflow:*` activity messages from the server.
