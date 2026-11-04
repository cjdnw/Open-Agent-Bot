/**
 * LangGraph-based Multi-Agent Workflow Engine Types (v0.5.0)
 *
 * Formal separation of:
 * 1. Fast Gate deterministic routing (L0 - L3)
 * 2. Judge Pre-Review (risk & acceptance criteria locking)
 * 3. Momo Autonomous Planning (SELF vs DELEGATE)
 * 4. Professional Worker Dispatching (Architect, Developer, Deploy, QA, Reporter)
 * 5. Judge Final Review (PASS / FAIL / BLOCKED with cryptographic artifact binding)
 * 6. LangGraph StateGraph & persistent checkpointing
 */

export type RouteLevel = "L0" | "L1" | "L2" | "L3";
export type Complexity = "SIMPLE" | "MODERATE" | "COMPLEX";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type ReasoningRecommendation = "HIGH" | "XHIGH";
export type MomoDecisionKind = "SELF" | "DELEGATE" | "ESCALATE";
export type JudgeVerdict = "PASS" | "FAIL" | "BLOCKED";

export const JUDGE_VERDICTS = ["PASS", "FAIL", "BLOCKED"] as const satisfies readonly JudgeVerdict[];
export const MAX_AUTO_REWORK = 2;

export interface FastGateResult {
  routeLevel: RouteLevel;
  routeReason: string;
  judgeRequired: boolean;
  suggestedComplexity: Complexity;
  suggestedRiskLevel: RiskLevel;
}

export type { GateResult, GateAuditRecord } from "./gate/types.ts";

import type {
  PreReview as CorePreReview,
  MomoPlan as CoreMomoPlan,
  ExecutionRecord as CoreExecutionRecord,
  FinalReview as CoreFinalReview,
} from "../workflow.ts";

export type PreReview = CorePreReview & { requiresHumanApproval?: boolean };
export type MomoPlan = CoreMomoPlan & { requestedEffort?: "HIGH" | "XHIGH" };
export type ExecutionRecord = CoreExecutionRecord;
export type FinalReview = CoreFinalReview;

export type WorkflowState =
  | "CREATED"
  | "FAST_GATE"
  | "PRE_REVIEW"
  | "WAITING_APPROVAL"
  | "PLANNING"
  | "EXECUTING"
  | "FINAL_REVIEW"
  | "REWORK"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "CANCELLED";

export interface WorkflowRun {
  runId: string;
  taskId: string;
  threadId: string;
  momoBotId: string;
  judgeBotId: string;
  userRequest: string;
  routeLevel: RouteLevel;
  routeReason: string;
  judgeRequired: boolean;
  criteriaVersion: string;
  state: WorkflowState;
  preReview?: PreReview;
  plan?: MomoPlan;
  execution?: ExecutionRecord;
  finalReview?: FinalReview;
  reworkCount: number;
  pendingApproval?: boolean;
  approvalGranted?: boolean | null;
  history: Array<{ state: string; at: number; note?: string }>;
  error?: string;
  createdAt: number;
  updatedAt: number;
  stageTokens: Partial<Record<WorkflowState, string>>;
}

export type WorkflowEventPayload = {
  runId: string;
  state: WorkflowState;
  stage: string;
  summary: string;
  detail?: unknown;
  ok?: boolean;
};

export interface WorkflowDeps {
  findBotByName: (name: string) => { id: string; name: string; title?: string; busy?: boolean } | undefined;
  findBotById: (id: string) => { id: string; name: string; title?: string; threadId: string; busy?: boolean } | undefined;
  listVisibleTeam: (exceptId: string) => Array<{ id: string; name: string; title?: string; busy?: boolean }>;
  runBotTurn: (
    botId: string,
    prompt: string,
    opts?: { reasoningEffort?: "high" | "xhigh"; label?: string },
  ) => Promise<{ ok: boolean; text: string; error?: string }>;
  canXHighForBot: (botId: string) => boolean;
  postWorkflowEvent: (threadId: string, event: WorkflowEventPayload) => void;
  postText: (threadId: string, text: string) => void;
  setBusy: (botId: string, busy: boolean) => void;
  interruptBot?: (botId: string) => Promise<void> | void;
  persistRun?: (run: WorkflowRun) => void;
  /** Injectable AI Gate (tests / force rule-only). Default: Gemini→Rule. */
  runAiGate?: (input: {
    taskId: string;
    userRequest: string;
    history?: Array<{ role: "user" | "assistant" | "system"; text: string }>;
  }) => Promise<import("./gate/types.ts").GateResult>;
}
