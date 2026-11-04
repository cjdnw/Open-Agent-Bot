/**
 * Dual-stage Judge + Momo-autonomous Workflow (v0.4.0).
 *
 * User → Momo → Judge PRE_REVIEW → Momo PLAN/EXECUTE → Judge FINAL_REVIEW → deliver
 *
 * Backend scheduler owns stage transitions. Momo chooses SELF / DELEGATE / ESCALATE.
 * Judge pre-review and final review are mandatory and cannot be simulated by Momo.
 */

export type WorkflowState =
  | "CREATED"
  | "PRE_REVIEW"
  | "PLANNING"
  | "EXECUTING"
  | "FINAL_REVIEW"
  | "REWORK"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "CANCELLED";

export type Complexity = "SIMPLE" | "MODERATE" | "COMPLEX";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type ReasoningRecommendation = "HIGH" | "XHIGH";
export type MomoDecisionKind = "SELF" | "DELEGATE" | "ESCALATE";
export type JudgeVerdict = "PASS" | "FAIL" | "BLOCKED";

export const JUDGE_VERDICTS = ["PASS", "FAIL", "BLOCKED"] as const satisfies readonly JudgeVerdict[];
export const MAX_AUTO_REWORK = 2;

export interface PreReview {
  taskId: string;
  complexity: Complexity;
  riskLevel: RiskLevel;
  reasoningRecommendation: ReasoningRecommendation;
  /** After capability check — may be lowered from Judge's ask. */
  reasoningEffective: ReasoningRecommendation;
  difficultyReason: string;
  recommendedRoles: string[];
  /** Optional per-role recommendation rationale from Judge. */
  roleReasons?: Record<string, string>;
  acceptanceCriteria: string[];
  requiredEvidence: string[];
  riskWarnings: string[];
  requiresUserAuthorization: boolean;
  rawText?: string;
  at: number;
}

export interface MomoTaskAssignment {
  role: string;
  objective: string;
  dependsOn?: string[];
}

export interface MomoPlan {
  decision: MomoDecisionKind;
  reason: string;
  delegateBotNames: string[];
  requestedEffort?: "HIGH" | "XHIGH";
  taskAssignments?: MomoTaskAssignment[];
  at: number;
}

export interface ExecutionRecord {
  actor: "momo" | "workers" | "mixed";
  summary: string;
  evidence: string[];
  artifactHash: string;
  reworkRound: number;
  at: number;
}

export interface FinalReview {
  verdict: JudgeVerdict;
  reason: string;
  criteriaVersion: string;
  artifactHash: string;
  evidenceGaps: string[];
  at: number;
  rawText?: string;
}

export interface WorkflowRun {
  runId: string;
  taskId: string;
  momoBotId: string;
  momoThreadId: string;
  judgeBotId: string;
  userRequest: string;
  /** Locked after PRE_REVIEW; new user requirements → new run. */
  criteriaVersion: string;
  state: WorkflowState;
  preReview?: PreReview;
  plan?: MomoPlan;
  execution?: ExecutionRecord;
  finalReview?: FinalReview;
  reworkCount: number;
  history: Array<{ state: WorkflowState; at: number; note?: string }>;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** Prevent duplicate Judge/exec side effects. */
  stageTokens: Partial<Record<WorkflowState, string>>;
}

export function newWorkflowIds(now = Date.now()) {
  const taskId = `task-${now.toString(36)}`;
  const runId = `wf-${now.toString(36)}`;
  return { taskId, runId, criteriaVersion: `crit-${now.toString(36)}` };
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  const edges: Record<WorkflowState, WorkflowState[]> = {
    CREATED: ["PRE_REVIEW", "CANCELLED", "FAILED"],
    PRE_REVIEW: ["PLANNING", "BLOCKED", "FAILED", "CANCELLED"],
    PLANNING: ["EXECUTING", "BLOCKED", "FAILED", "CANCELLED"],
    EXECUTING: ["FINAL_REVIEW", "FAILED", "CANCELLED", "BLOCKED"],
    FINAL_REVIEW: ["COMPLETED", "REWORK", "BLOCKED", "FAILED", "CANCELLED"],
    REWORK: ["PLANNING", "EXECUTING", "FAILED", "CANCELLED", "BLOCKED"],
    COMPLETED: [],
    BLOCKED: ["CANCELLED"],
    FAILED: [],
    CANCELLED: [],
  };
  return edges[from]?.includes(to) ?? false;
}

export function transition(run: WorkflowRun, to: WorkflowState, note?: string): WorkflowRun {
  if (!canTransition(run.state, to)) {
    throw new Error(`illegal workflow transition ${run.state} → ${to}`);
  }
  const at = Date.now();
  return {
    ...run,
    state: to,
    updatedAt: at,
    history: [...run.history, { state: to, at, note }],
  };
}

export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  const m = text.trim().toUpperCase().match(/\b(PASS|FAIL|BLOCKED)\b/);
  return m ? (m[1] as JudgeVerdict) : null;
}

export function isJudgeVerdict(text: string): boolean {
  return parseJudgeVerdict(text) !== null;
}

function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() || text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

export function parsePreReview(text: string, taskId: string, canXHigh: boolean): PreReview | null {
  const obj = extractJsonObject(text) as Record<string, unknown> | null;
  if (!obj) return null;
  const complexity = String(obj.complexity || "").toUpperCase();
  const riskLevel = String(obj.riskLevel || "").toUpperCase();
  let reasoning = String(obj.reasoningRecommendation || "HIGH").toUpperCase();
  if (reasoning !== "HIGH" && reasoning !== "XHIGH") reasoning = "HIGH";
  if (complexity !== "SIMPLE" && complexity !== "MODERATE" && complexity !== "COMPLEX") return null;
  if (riskLevel !== "LOW" && riskLevel !== "MEDIUM" && riskLevel !== "HIGH") return null;
  const recommended = asStringArray(obj.recommendedRoles);
  const criteria = asStringArray(obj.acceptanceCriteria);
  if (criteria.length === 0) return null;
  const effective: ReasoningRecommendation =
    reasoning === "XHIGH" && canXHigh ? "XHIGH" : "HIGH";
  const requiresUserAuthorization =
    obj.requiresUserAuthorization === true ||
    (riskLevel === "HIGH" && obj.requiresUserAuthorization !== false);
  let roleReasons: Record<string, string> | undefined;
  if (obj.roleReasons && typeof obj.roleReasons === "object" && !Array.isArray(obj.roleReasons)) {
    roleReasons = {};
    for (const [k, v] of Object.entries(obj.roleReasons as Record<string, unknown>)) {
      const reason = String(v || "").trim();
      if (k.trim() && reason) roleReasons[k.trim()] = reason;
    }
    if (Object.keys(roleReasons).length === 0) roleReasons = undefined;
  }
  return {
    taskId: String(obj.taskId || taskId),
    complexity: complexity as Complexity,
    riskLevel: riskLevel as RiskLevel,
    reasoningRecommendation: reasoning as ReasoningRecommendation,
    reasoningEffective: effective,
    difficultyReason: String(obj.difficultyReason || "").trim() || "unspecified",
    recommendedRoles: recommended,
    roleReasons,
    acceptanceCriteria: criteria,
    requiredEvidence: asStringArray(obj.requiredEvidence),
    riskWarnings: asStringArray(obj.riskWarnings),
    requiresUserAuthorization,
    rawText: text,
    at: Date.now(),
  };
}

export function parseMomoPlan(text: string): MomoPlan | null {
  const obj = extractJsonObject(text) as Record<string, unknown> | null;
  if (!obj) return null;
  const decision = String(obj.decision || obj.executionMode || "").toUpperCase();
  if (decision !== "SELF" && decision !== "DELEGATE" && decision !== "ESCALATE") return null;
  const roles = asStringArray(
    obj.delegateBotNames || obj.selectedRoles || obj.delegateTo || obj.workers,
  );
  let requestedEffort: "HIGH" | "XHIGH" | undefined;
  const effort = String(obj.requestedEffort || "").toUpperCase();
  if (effort === "HIGH" || effort === "XHIGH") requestedEffort = effort;
  let taskAssignments: MomoTaskAssignment[] | undefined;
  if (Array.isArray(obj.taskAssignments)) {
    const parsed: MomoTaskAssignment[] = [];
    for (const item of obj.taskAssignments) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const role = String(rec.role || "").trim();
      if (!role) continue;
      const dependsOn = asStringArray(rec.dependsOn);
      parsed.push({
        role,
        objective: String(rec.objective || "").trim() || "unspecified",
        ...(dependsOn.length ? { dependsOn } : {}),
      });
    }
    if (parsed.length > 0) taskAssignments = parsed;
  }
  return {
    decision: decision as MomoDecisionKind,
    reason: String(obj.reason || obj.decisionReason || "").trim() || "unspecified",
    delegateBotNames: roles,
    requestedEffort,
    taskAssignments,
    at: Date.now(),
  };
}

export function parseFinalReview(text: string, criteriaVersion: string, artifactHash: string): FinalReview | null {
  const obj = extractJsonObject(text) as Record<string, unknown> | null;
  const verdict = obj
    ? (String(obj.verdict || obj.result || "").toUpperCase() as string)
    : parseJudgeVerdict(text);
  if (verdict !== "PASS" && verdict !== "FAIL" && verdict !== "BLOCKED") return null;
  return {
    verdict: verdict as JudgeVerdict,
    reason: obj ? String(obj.reason || obj.explanation || "").trim() : text.trim().slice(0, 500),
    criteriaVersion: obj ? String(obj.criteriaVersion || criteriaVersion) : criteriaVersion,
    artifactHash: obj ? String(obj.artifactHash || artifactHash) : artifactHash,
    evidenceGaps: obj ? asStringArray(obj.evidenceGaps) : [],
    at: Date.now(),
    rawText: text,
  };
}

/** Reject PASS that does not bind the current artifact / criteria. */
export function validateFinalBinding(
  review: FinalReview,
  criteriaVersion: string,
  artifactHash: string,
): FinalReview {
  if (review.verdict !== "PASS") return review;
  if (review.criteriaVersion !== criteriaVersion || review.artifactHash !== artifactHash) {
    return {
      ...review,
      verdict: "BLOCKED",
      reason: `PASS rejected: criteria/artifact mismatch (got ${review.criteriaVersion}/${review.artifactHash}, need ${criteriaVersion}/${artifactHash})`,
      evidenceGaps: [...review.evidenceGaps, "stale_or_mismatched_pass_binding"],
    };
  }
  return review;
}

export async function hashArtifact(parts: string[]): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(parts.join("\n---\n")).digest("hex").slice(0, 16);
}
