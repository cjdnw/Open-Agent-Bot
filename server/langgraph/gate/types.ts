import type { Complexity, RiskLevel, RouteLevel } from "../types.ts";

export type GateTaskType =
  | "CHAT"
  | "QA_READONLY"
  | "CODE_MODIFICATION"
  | "FILE_WRITE"
  | "DEPLOYMENT"
  | "DESTRUCTIVE"
  | "ANALYSIS"
  | "UNKNOWN";

export type GateClassifierSource = "GEMINI" | "RULE_FALLBACK";

export type GateFailureReason =
  | "TIMEOUT"
  | "AUTH_ERROR"
  | "QUOTA_EXHAUSTED"
  | "NETWORK_ERROR"
  | "INVALID_JSON"
  | "INVALID_CLASSIFICATION"
  | "MODEL_UNAVAILABLE"
  | "DISABLED"
  | "UNKNOWN_ERROR";

export type GateValidationStatus = "OK" | "REJECTED" | "SKIPPED";

export interface AiGateClassification {
  routeLevel: RouteLevel;
  taskType: GateTaskType;
  complexityEstimate: Complexity;
  riskEstimate: RiskLevel;
  requiresWrite: boolean;
  requiresExternalAction: boolean;
  requiresFormalReview: boolean;
  requiresHumanApproval: boolean;
  confidence: number;
  reason: string;
}

export interface GateAuditRecord {
  taskId: string;
  classifierSource: GateClassifierSource;
  modelId: string | null;
  routeLevel: RouteLevel;
  routeReason: string;
  riskLevel: RiskLevel;
  validationStatus: GateValidationStatus;
  fallbackReason: GateFailureReason | null;
  elapsedMs: number;
  timestamp: number;
  confidence?: number;
  taskType?: GateTaskType;
}

export interface GateResult {
  routeLevel: RouteLevel;
  routeReason: string;
  judgeRequired: boolean;
  suggestedComplexity: Complexity;
  suggestedRiskLevel: RiskLevel;
  requiresHumanApproval: boolean;
  requiresWrite: boolean;
  requiresExternalAction: boolean;
  requiresFormalReview: boolean;
  taskType: GateTaskType;
  confidence: number;
  audit: GateAuditRecord;
}

export interface MessageContext {
  role: "user" | "assistant" | "system";
  text: string;
}

/** Light thinking — not High. */
export const AI_GATE_MODEL_ID = "gemini-3.8-flash-low";
export const AI_GATE_PROVIDER = "antigravity";

export function gateConfig() {
  const enabledRaw = (process.env.OMB_AI_GATE_ENABLED ?? "true").toLowerCase();
  const enabled = !(enabledRaw === "0" || enabledRaw === "false" || enabledRaw === "off");
  const timeoutMs = Math.min(
    30_000,
    Math.max(1_000, Number(process.env.OMB_AI_GATE_TIMEOUT_MS || 8_000) || 8_000),
  );
  // Force light model even if env mistakenly points at *-high.
  const rawModel = process.env.OMB_AI_GATE_MODEL || AI_GATE_MODEL_ID;
  const modelId = /flash-high$/i.test(rawModel)
    ? AI_GATE_MODEL_ID
    : rawModel || AI_GATE_MODEL_ID;
  const cli = process.env.OMB_AGY_CLI || process.env.AGY_CLI || "agy";
  return { enabled, timeoutMs, modelId, cli };
}
