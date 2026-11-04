# Open-Agent-Bot v0.5 — LangGraph Multi-Agent Workflow

## LangGraph version

- `@langchain/langgraph`: `^1.6.1` (resolved from package.json / lockfile)
- `@langchain/core`: `^1.3.4`

Workflow is a real `StateGraph` with nodes, fixed edges, conditional edges, file checkpointer, and `interrupt` / `Command({ resume })` for human approval. Bot turns still go through the existing Provider Adapter + FallbackOrchestrator (`runBotTurn`).

## Workflow state

Typed via `Annotation.Root` in `server/langgraph/state.ts`, including:

`workflowId`, `threadId`, `userRequest`, `routeLevel`, `routeReason`, `complexity`, `riskLevel`, `acceptanceCriteria`, `judgePreReview`, `momoDecision`, `executionMode`, `selectedBots`, `currentExecutor`, `executionStatus`, artifact/evidence refs, `judgeFinalVerdict`, `reworkCount`, `pendingApproval`, `activeAttemptId`, `errors`, `timestamps`, `history`.

Deterministic routing fields come from Fast Gate; model judgments from Judge/Momo parsers; execution evidence from bot turn text + artifact hash.

## Fast Gate

Pure rules in `server/langgraph/fast-gate.ts` (no LLM):

| Level | Behavior |
|-------|----------|
| L0 | Exact short greetings → Momo chat only |
| L1 | Read-only / explain / quota query → Momo light; may upgrade to L2 |
| L2 | Code/docs/analysis → Judge pre + final |
| L3 | Deploy/delete/SSH/prod → Judge pre + human approval + final |

Danger keywords in a greeting (`hello，删除数据库`) force L3. Multi-turn history is considered. Uncertain → formal path.

## Judge dual stage

1. **Pre-Review** — real Judge bot turn; structured complexity/risk/effort/roles/criteria; failure → `BLOCKED` (never silent continue).
2. **Final Review** — real Judge bot turn; `PASS` / `FAIL` / `BLOCKED`; PASS bound to `criteriaVersion` + `artifactHash` via `validateFinalBinding`. Auto-rework on FAIL ≤ 2 (`MAX_AUTO_REWORK`).

## Momo autonomy

Planner returns structured `SELF` | `DELEGATE` | `ESCALATE`. Conditional edges route to Momo executor or worker dispatcher. SELF is allowed for SIMPLE/MODERATE/COMPLEX when authorization rules are met. False “协作流已关闭” solo excuses are neutralized without forcing DELEGATE for every task.

## Worker dispatch

LangGraph schedules Architect / Developer / Deploy / QA / Reporter when Momo chooses DELEGATE. Serial execution under `workspace-write` resource lock. Results synthesized by Momo, then Judge final. `ask_bot` remains for ad-hoc collab but must not drive the formal Judge stages while a workflow owns the chat.

## Checkpointer & recovery

`FileCheckpointSaver` under `~/.cjdnw_bot/langgraph-checkpoints` (or `DATA_DIR`). Secrets redacted. Production does not rely on memory-only saver. On process start, `recoverIncompleteWorkflows` cancels in-flight runs and clears busy — side-effecting steps are **not** replayed. Human approval uses LangGraph `interrupt`; resume via `POST /api/workflow/:runId/approve`.

## UI

Existing `workflow:*` stage cards in ChatView show Fast Gate / Pre-Review / Plan / Worker / Final / Delivery events posted by the engine. Formal completion requires Judge PASS before delivery copy marks acceptance.

## Tests

`server/langgraph/langgraph-workflow.test.ts` — Fast Gate matrix, Judge pre/final, SELF/DELEGATE edges, rework cap, cancel, interrupt/resume, 100× mock L0/L1 stress.

## WorkerRegistry + RoutingGuard (supplement)

- `server/langgraph/worker-registry.ts` — live botId binding, capability catalog, availability, tool/ops matching with audit `matchReasons`.
- `server/langgraph/routing-guard.ts` — deterministic validation: SELF allowed despite Judge roles; DELEGATE existence/availability/tools/cycles; one Momo retry; then recorded `routingSource: ROUTING_GUARD` fallback / ESCALATE / BLOCKED.
- Graph path: Judge Pre-Review → WorkerRegistry → Momo → RoutingGuard → Executor → Judge Final. L0/L1 skip registry scheduling.
- Model Fallback remains inside each bot's `runBotTurn`; RoutingGuard never swaps workers because a model failed.

## Known limits

- Real paid-provider E2E depends on local CLI/API credentials; CI uses mocks.
- Parallel workers are serialized by write lock (safe, not maximally parallel).
- Restart cancels in-flight workflows rather than auto-resume mid-shell.

## Rollback

```bash
git checkout open-agent-bot
# or revert to prior SHA on feature/langgraph-workflow
pnpm exec node scripts/deploy-cjdnw-bot.mjs
```

Desktop install: `%USERPROFILE%\Desktop\cjdnw_bot` + `cjdnw_bot.lnk`. Data dir `%USERPROFILE%\.cjdnw_bot` is preserved across redeploy.
