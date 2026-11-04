import { join } from "node:path";
import { Command, isGraphInterrupt, isInterrupted } from "@langchain/langgraph";
import { DATA_DIR } from "../config.ts";
import type { WorkflowDeps, WorkflowRun, WorkflowState } from "./types.ts";
import { FileCheckpointSaver } from "./checkpointer.ts";
import { buildLangGraphWorkflow } from "./graph.ts";
import type { WorkflowGraphState } from "./state.ts";

const CHECKPOINT_DIR = join(DATA_DIR, "langgraph-checkpoints");
const activeByMomo = new Map<string, string>(); // momoBotId -> runId
const activeRuns = new Map<string, WorkflowRun>();
const activeAbortControllers = new Map<string, AbortController>();

let defaultCheckpointer: FileCheckpointSaver | null = null;

export function getCheckpointer(): FileCheckpointSaver {
  if (!defaultCheckpointer) {
    defaultCheckpointer = new FileCheckpointSaver(CHECKPOINT_DIR);
  }
  return defaultCheckpointer;
}

export function isJudgeBotName(name: string): boolean {
  return /^judge$/i.test(name.trim());
}

export function getActiveWorkflowForMomo(momoBotId: string): WorkflowRun | undefined {
  const runId = activeByMomo.get(momoBotId);
  return runId ? activeRuns.get(runId) : undefined;
}

export function loadWorkflowRun(runId: string): WorkflowRun | undefined {
  return activeRuns.get(runId);
}

function resolveTerminalState(finalState: WorkflowGraphState, latest: WorkflowRun): WorkflowState {
  if (isInterrupted(finalState) || finalState.pendingApproval || finalState.executionStatus === "WAITING_APPROVAL") {
    return "WAITING_APPROVAL";
  }

  const executionStatus = (finalState.executionStatus as WorkflowState) || "COMPLETED";
  const finalVerdict = finalState.judgeFinalVerdict;

  if (executionStatus === "BLOCKED" || finalVerdict === "BLOCKED") return "BLOCKED";
  if (executionStatus === "FAILED" || (finalState.errors?.length ?? 0) > 0) return "FAILED";
  if (executionStatus === "CANCELLED") return "CANCELLED";
  if (finalState.routeLevel === "L0" || finalState.routeLevel === "L1") {
    return String(executionStatus) === "FAILED" ? "FAILED" : "COMPLETED";
  }
  if (finalVerdict === "PASS") return "COMPLETED";
  if (finalVerdict === "FAIL") return "FAILED";
  // Formal tasks without a final verdict are not successfully completed.
  if (finalState.judgeRequired && !finalVerdict) {
    return latest.state === "WAITING_APPROVAL" ? "WAITING_APPROVAL" : "FAILED";
  }
  return latest.state === "WAITING_APPROVAL" ? "WAITING_APPROVAL" : "COMPLETED";
}

function syncRunFromGraphState(latest: WorkflowRun, finalState: WorkflowGraphState, state: WorkflowState): WorkflowRun {
  return {
    ...latest,
    state,
    routeLevel: finalState.routeLevel || latest.routeLevel,
    routeReason: finalState.routeReason || latest.routeReason,
    judgeRequired: finalState.judgeRequired ?? latest.judgeRequired,
    preReview: finalState.judgePreReview || undefined,
    plan: finalState.momoDecision || undefined,
    execution: finalState.executionRecord || undefined,
    finalReview: finalState.judgeFinalReview || undefined,
    reworkCount: finalState.reworkCount ?? 0,
    pendingApproval: finalState.pendingApproval || false,
    approvalGranted: finalState.approvalGranted,
    error: finalState.errors?.length ? finalState.errors.join("; ") : undefined,
    updatedAt: Date.now(),
    history: [...latest.history, ...(finalState.history || [])],
  };
}

async function finishGraphRun(
  deps: WorkflowDeps,
  runId: string,
  momoId: string,
  compiledGraph: ReturnType<typeof buildLangGraphWorkflow>,
  input: unknown,
): Promise<void> {
  const abortController = activeAbortControllers.get(runId) || new AbortController();
  activeAbortControllers.set(runId, abortController);

  let keepActiveForApproval = false;

  try {
    const finalState = (await compiledGraph.invoke(input as never, {
      configurable: { thread_id: runId },
      signal: abortController.signal,
    })) as WorkflowGraphState;

    const latest = activeRuns.get(runId);
    if (!latest) return;

    // LangGraph.js interrupt returns values with __interrupt__ instead of always throwing.
    if (isInterrupted(finalState)) {
      keepActiveForApproval = true;
      const waiting = syncRunFromGraphState(
        latest,
        {
          ...finalState,
          pendingApproval: true,
          executionStatus: "WAITING_APPROVAL",
          history: [
            ...(finalState.history || []),
            { state: "WAITING_APPROVAL", at: Date.now(), note: "LangGraph interrupt awaiting human approval" },
          ],
        },
        "WAITING_APPROVAL",
      );
      waiting.pendingApproval = true;
      activeRuns.set(runId, waiting);
      deps.persistRun?.(waiting);
      return;
    }

    const resolvedState = resolveTerminalState(finalState, latest);
    if (resolvedState === "WAITING_APPROVAL") {
      keepActiveForApproval = true;
    }
    const completedRun = syncRunFromGraphState(latest, finalState, resolvedState);
    if (resolvedState === "WAITING_APPROVAL") {
      completedRun.pendingApproval = true;
    }
    activeRuns.set(runId, completedRun);
    deps.persistRun?.(completedRun);
  } catch (error: unknown) {
    if (isGraphInterrupt(error)) {
      keepActiveForApproval = true;
      const latest = activeRuns.get(runId);
      if (latest) {
        const waiting: WorkflowRun = {
          ...latest,
          state: "WAITING_APPROVAL",
          pendingApproval: true,
          updatedAt: Date.now(),
          history: [...latest.history, { state: "WAITING_APPROVAL", at: Date.now(), note: "LangGraph interrupt" }],
        };
        activeRuns.set(runId, waiting);
        deps.persistRun?.(waiting);
      }
      return;
    }

    const isAbort =
      abortController.signal.aborted ||
      (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)));
    const latest = activeRuns.get(runId);
    if (!latest) return;

    const stateKind: WorkflowState = isAbort ? "CANCELLED" : "FAILED";
    const errStr = error instanceof Error ? error.message : String(error);
    const failedRun: WorkflowRun = {
      ...latest,
      state: stateKind,
      error: errStr,
      updatedAt: Date.now(),
      history: [...latest.history, { state: stateKind, at: Date.now(), note: errStr }],
    };
    activeRuns.set(runId, failedRun);
    deps.persistRun?.(failedRun);

    if (!isAbort) {
      deps.postWorkflowEvent(latest.threadId, {
        runId,
        state: "FAILED",
        stage: "FAILED",
        summary: `Workflow 异常中断: ${errStr}`,
        ok: false,
      });
      deps.postText(latest.threadId, `Workflow 异常失败：${errStr}\n未经 Judge PASS 不算已验收交付。`);
    }
  } finally {
    if (!keepActiveForApproval) {
      activeByMomo.delete(momoId);
      activeAbortControllers.delete(runId);
    }
    deps.setBusy(momoId, false);
  }
}

/**
 * Start a multi-agent workflow using LangGraph.js.
 */
export async function startWorkflow(
  deps: WorkflowDeps,
  input: { momoBotId: string; userRequest: string; judgeName?: string },
): Promise<WorkflowRun> {
  const momo = deps.findBotById(input.momoBotId);
  if (!momo) throw Object.assign(new Error("Momo bot missing"), { status: 404 });
  if (getActiveWorkflowForMomo(momo.id)) {
    throw Object.assign(new Error("A workflow is already running for Momo — interrupt it first"), { status: 409 });
  }

  const judge = deps.findBotByName(input.judgeName || "Judge");
  if (!judge) throw Object.assign(new Error("Judge bot not found"), { status: 409 });

  const now = Date.now();
  const runId = `wf-${now.toString(36)}`;
  const taskId = `task-${now.toString(36)}`;

  const run: WorkflowRun = {
    runId,
    taskId,
    threadId: momo.threadId,
    momoBotId: momo.id,
    judgeBotId: judge.id,
    userRequest: input.userRequest,
    routeLevel: "L2",
    routeReason: "",
    judgeRequired: true,
    criteriaVersion: `crit-${now.toString(36)}`,
    state: "CREATED",
    reworkCount: 0,
    history: [{ state: "CREATED", at: now }],
    createdAt: now,
    updatedAt: now,
    stageTokens: {},
  };

  activeByMomo.set(momo.id, runId);
  activeRuns.set(runId, run);
  deps.setBusy(momo.id, true);

  const checkpointer = getCheckpointer();
  const compiledGraph = buildLangGraphWorkflow(deps, checkpointer);
  const abortController = new AbortController();
  activeAbortControllers.set(runId, abortController);

  const initialState: Partial<WorkflowGraphState> = {
    workflowId: runId,
    threadId: momo.threadId,
    momoBotId: momo.id,
    judgeBotId: judge.id,
    userRequest: input.userRequest,
    reworkCount: 0,
    timestamps: { start: Date.now() },
    errors: [],
    history: [{ state: "STARTED", at: Date.now() }],
  };

  void finishGraphRun(deps, runId, momo.id, compiledGraph, initialState);

  return run;
}

/**
 * Cancel an in-flight workflow.
 */
export function cancelWorkflow(
  deps: WorkflowDeps,
  momoBotId: string,
  reason = "cancelled by user",
): boolean {
  const runId = activeByMomo.get(momoBotId);
  const run = runId ? activeRuns.get(runId) : undefined;
  if (!run) return false;
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) return false;

  const controller = activeAbortControllers.get(run.runId);
  controller?.abort();

  const nextRun: WorkflowRun = {
    ...run,
    state: "CANCELLED",
    error: reason,
    pendingApproval: false,
    updatedAt: Date.now(),
    history: [...run.history, { state: "CANCELLED", at: Date.now(), note: reason }],
  };

  activeRuns.set(run.runId, nextRun);
  activeByMomo.delete(momoBotId);
  activeAbortControllers.delete(run.runId);
  deps.setBusy(momoBotId, false);
  deps.persistRun?.(nextRun);

  deps.postWorkflowEvent(run.threadId, {
    runId: run.runId,
    state: "CANCELLED",
    stage: "CANCELLED",
    summary: reason,
    ok: false,
  });

  for (const botId of [momoBotId, run.judgeBotId]) {
    try {
      void deps.interruptBot?.(botId);
    } catch {
      /* ignore */
    }
  }

  for (const peer of deps.listVisibleTeam(momoBotId)) {
    if (peer.busy && peer.id !== run.judgeBotId) {
      try {
        void deps.interruptBot?.(peer.id);
      } catch {
        /* ignore */
      }
    }
  }

  return true;
}

/**
 * Approve or reject a workflow waiting on LangGraph interrupt.
 */
export async function approveWorkflow(
  deps: WorkflowDeps,
  runId: string,
  approved: boolean,
): Promise<boolean> {
  const run = activeRuns.get(runId);
  if (!run || run.state !== "WAITING_APPROVAL") return false;

  const checkpointer = getCheckpointer();
  const compiledGraph = buildLangGraphWorkflow(deps, checkpointer);

  const updatedRun: WorkflowRun = {
    ...run,
    approvalGranted: approved,
    pendingApproval: false,
    updatedAt: Date.now(),
    history: [
      ...run.history,
      {
        state: approved ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED",
        at: Date.now(),
        note: approved ? "Approved by user" : "Rejected by user",
      },
    ],
  };
  activeRuns.set(runId, updatedRun);
  deps.persistRun?.(updatedRun);

  if (!approved) {
    cancelWorkflow(deps, run.momoBotId, "User rejected approval");
    // Still resume so the interrupt node can finish cleanly if checkpoint expects it.
    try {
      await compiledGraph.invoke(new Command({ resume: false }), {
        configurable: { thread_id: runId },
      });
    } catch {
      /* graph may already be cancelled */
    }
    return true;
  }

  deps.setBusy(run.momoBotId, true);
  activeByMomo.set(run.momoBotId, runId);
  void finishGraphRun(deps, runId, run.momoBotId, compiledGraph, new Command({ resume: true }));
  return true;
}

/**
 * On server startup: mark in-flight workflows cancelled so bots are never stuck busy.
 * Side-effecting shell/git/ssh steps are NOT replayed after restart.
 */
export function recoverIncompleteWorkflows(deps: WorkflowDeps): void {
  try {
    const checkpointer = getCheckpointer();
    const threadIds = checkpointer.listThreadIds();

    for (const threadId of threadIds) {
      const run = activeRuns.get(threadId);
      if (run && !["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(run.state)) {
        run.state = "CANCELLED";
        run.error = "Application restarted while workflow was in-flight — awaiting verification, not replayed";
        run.pendingApproval = false;
        run.updatedAt = Date.now();
        run.history.push({
          state: "CANCELLED",
          at: Date.now(),
          note: "Server restarted — in-flight workflow cancelled safely (no side-effect replay)",
        });
        activeRuns.set(threadId, run);
        deps.persistRun?.(run);
        deps.setBusy(run.momoBotId, false);
        activeByMomo.delete(run.momoBotId);
      }
    }

    // Also clear any busy flags for moms that had an active map entry in-memory only
    for (const [momoId, runId] of [...activeByMomo.entries()]) {
      const run = activeRuns.get(runId);
      if (!run || !["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(run.state)) {
        if (run) {
          run.state = "CANCELLED";
          run.error = "Application restarted while workflow was in-flight";
          run.updatedAt = Date.now();
          activeRuns.set(runId, run);
          deps.persistRun?.(run);
        }
        deps.setBusy(momoId, false);
        activeByMomo.delete(momoId);
      }
    }
  } catch (err) {
    console.warn("Failed during recoverIncompleteWorkflows:", err);
  }
}
