/**
 * Workflow Orchestrator (v0.5.0)
 *
 * Backed by LangGraph.js Engine (`server/langgraph/`).
 *
 * Implements:
 * 1. Fast Gate (L0/L1 fast routing, L2/L3 formal task routing)
 * 2. Judge Pre-Review (acceptance criteria & risk locking)
 * 3. Momo Autonomous Planning (SELF vs DELEGATE without forced delegation)
 * 4. Professional Worker Dispatching (Architect, Developer, Deploy, QA, Reporter)
 * 5. Judge Final Review (PASS / FAIL / BLOCKED with cryptographic hash binding)
 * 6. LangGraph StateGraph, conditional edges, and persistent checkpointer
 */

import {
  type WorkflowDeps,
  type WorkflowEventPayload,
  type WorkflowRun,
  type WorkflowState,
  startWorkflow as langgraphStartWorkflow,
  cancelWorkflow as langgraphCancelWorkflow,
  approveWorkflow as langgraphApproveWorkflow,
  getActiveWorkflowForMomo as langgraphGetActiveWorkflowForMomo,
  loadWorkflowRun as langgraphLoadWorkflowRun,
  isJudgeBotName as langgraphIsJudgeBotName,
  isWorkflowInfrastructureBot,
  recoverIncompleteWorkflows,
} from "./langgraph/index.ts";

export type { WorkflowDeps, WorkflowEventPayload, WorkflowRun, WorkflowState };

export {
  langgraphApproveWorkflow as approveWorkflow,
  recoverIncompleteWorkflows,
};

export function isJudgeBotName(name: string): boolean {
  return langgraphIsJudgeBotName(name);
}

export function loadWorkflowRun(runId: string): WorkflowRun | undefined {
  return langgraphLoadWorkflowRun(runId);
}

export function getActiveWorkflowForMomo(momoBotId: string): WorkflowRun | undefined {
  return langgraphGetActiveWorkflowForMomo(momoBotId);
}

/**
 * Block Momo from ask_bot'ing Judge while a workflow owns the chat.
 */
export function workflowBlocksAskBot(momoBotId: string, targetBotName: string): string | null {
  const run = getActiveWorkflowForMomo(momoBotId);
  if (!run) return null;
  if (["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(run.state)) return null;
  if (isJudgeBotName(targetBotName)) {
    return "workflow scheduler owns Judge stages — Momo must not ask_bot Judge or simulate review";
  }
  return null;
}

/**
 * Start workflow using LangGraph.js StateGraph engine.
 */
export async function startWorkflow(
  deps: WorkflowDeps,
  input: { momoBotId: string; userRequest: string; judgeName?: string },
): Promise<WorkflowRun> {
  return await langgraphStartWorkflow(deps, input);
}

/**
 * Cancel workflow and interrupt all active bot turns.
 */
export function cancelWorkflow(
  deps: WorkflowDeps,
  momoBotId: string,
  reason = "cancelled by user",
): boolean {
  return langgraphCancelWorkflow(deps, momoBotId, reason);
}

/**
 * Legacy compatibility helper for Momo plan coercion.
 * Keeps Momo's genuine autonomy for SELF decisions while overriding invalid false claims.
 */
export function coerceCollabPlan(
  plan: {
    decision: "SELF" | "DELEGATE" | "ESCALATE";
    reason: string;
    delegateBotNames: string[];
    at: number;
  },
  pre: { complexity: string; riskLevel: string; recommendedRoles: string[] },
  team: Array<{ name: string; title?: string }>,
): typeof plan {
  if (plan.decision === "ESCALATE") return plan;
  const staff = team.filter((b) => !isWorkflowInfrastructureBot(b.name));
  if (staff.length === 0) return plan;

  const falseSolo = /协作流已关闭|只能自干/.test(plan.reason);
  if (falseSolo) {
    return {
      ...plan,
      decision: "DELEGATE",
      reason: `协作流已开启，覆盖错误的 solo 假设（原理由：${plan.reason}）`,
      delegateBotNames: pre.recommendedRoles.length > 0 ? pre.recommendedRoles : [staff[0]!.name],
    };
  }

  // Preserve Momo's autonomy to choose SELF for SIMPLE or MODERATE tasks
  return plan;
}
