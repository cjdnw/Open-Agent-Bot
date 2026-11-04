import type { AiGateClassification, GateTaskType } from "./types.ts";
import type { Complexity, RiskLevel, RouteLevel } from "../types.ts";

const ROUTE_LEVELS = new Set<RouteLevel>(["L0", "L1", "L2", "L3"]);
const COMPLEXITIES = new Set<Complexity>(["SIMPLE", "MODERATE", "COMPLEX"]);
const RISKS = new Set<RiskLevel>(["LOW", "MEDIUM", "HIGH"]);
const TASK_TYPES = new Set<GateTaskType>([
  "CHAT",
  "QA_READONLY",
  "CODE_MODIFICATION",
  "FILE_WRITE",
  "DEPLOYMENT",
  "DESTRUCTIVE",
  "ANALYSIS",
  "UNKNOWN",
]);

const FORBIDDEN_SYSTEM_KEYS = new Set([
  "apiKey",
  "token",
  "authorization",
  "password",
  "cookie",
  "secret",
]);

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]!.trim() : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type GateParseResult =
  | { ok: true; value: AiGateClassification; upgraded: boolean; upgradeReason?: string }
  | { ok: false; error: "INVALID_JSON" | "INVALID_CLASSIFICATION"; detail: string };

/**
 * Type-safe parse + safety constraints for AI Gate JSON.
 * Deterministic upgrades when model under-classifies write/risk tasks.
 */
export function parseAndValidateGateJson(text: string): GateParseResult {
  const obj = extractJsonObject(text);
  if (!obj) return { ok: false, error: "INVALID_JSON", detail: "no JSON object" };

  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_SYSTEM_KEYS.has(key) || /apikey|token|password|secret/i.test(key)) {
      return { ok: false, error: "INVALID_CLASSIFICATION", detail: `forbidden field: ${key}` };
    }
  }

  const routeLevel = String(obj.routeLevel || "").toUpperCase() as RouteLevel;
  const taskType = String(obj.taskType || "UNKNOWN").toUpperCase() as GateTaskType;
  const complexityEstimate = String(obj.complexityEstimate || "MODERATE").toUpperCase() as Complexity;
  const riskEstimate = String(obj.riskEstimate || "MEDIUM").toUpperCase() as RiskLevel;

  if (!ROUTE_LEVELS.has(routeLevel)) {
    return { ok: false, error: "INVALID_CLASSIFICATION", detail: `bad routeLevel: ${routeLevel}` };
  }
  if (!TASK_TYPES.has(taskType)) {
    return { ok: false, error: "INVALID_CLASSIFICATION", detail: `bad taskType: ${taskType}` };
  }
  if (!COMPLEXITIES.has(complexityEstimate)) {
    return { ok: false, error: "INVALID_CLASSIFICATION", detail: `bad complexityEstimate` };
  }
  if (!RISKS.has(riskEstimate)) {
    return { ok: false, error: "INVALID_CLASSIFICATION", detail: `bad riskEstimate` };
  }

  const requiresWrite = obj.requiresWrite === true;
  const requiresExternalAction = obj.requiresExternalAction === true;
  const requiresFormalReview = obj.requiresFormalReview === true || routeLevel === "L2" || routeLevel === "L3";
  const requiresHumanApproval = obj.requiresHumanApproval === true || routeLevel === "L3";
  const confidenceRaw = Number(obj.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5;
  const reason = String(obj.reason || "").trim() || "unspecified";

  let level = routeLevel;
  let upgraded = false;
  let upgradeReason: string | undefined;

  // Safety constraints — model classification cannot under-route writes/risk.
  if (requiresWrite && (level === "L0" || level === "L1")) {
    level = "L2";
    upgraded = true;
    upgradeReason = "requiresWrite=true cannot stay on L0/L1";
  }
  if (
    (taskType === "CODE_MODIFICATION" || taskType === "FILE_WRITE" || taskType === "ANALYSIS") &&
    (level === "L0" || level === "L1") &&
    (requiresWrite || requiresFormalReview || requiresExternalAction)
  ) {
    level = "L2";
    upgraded = true;
    upgradeReason = upgradeReason || "formal write/analysis task cannot stay on L0/L1";
  }
  if (taskType === "DEPLOYMENT" || taskType === "DESTRUCTIVE" || riskEstimate === "HIGH") {
    if (level === "L0" || level === "L1" || level === "L2") {
      // HIGH risk / destructive must not remain chat/light; prefer L3
      if (taskType === "DEPLOYMENT" || taskType === "DESTRUCTIVE" || requiresHumanApproval) {
        level = "L3";
        upgraded = true;
        upgradeReason = upgradeReason || "high-risk/destructive/deployment forced to L3";
      } else if (level === "L0" || level === "L1") {
        level = "L2";
        upgraded = true;
        upgradeReason = upgradeReason || "HIGH risk cannot stay on L0/L1";
      }
    }
  }
  if (requiresFormalReview && (level === "L0" || level === "L1")) {
    level = "L2";
    upgraded = true;
    upgradeReason = upgradeReason || "requiresFormalReview cannot stay on L0/L1";
  }
  // Contradiction: L3 with LOW risk and no write/external is suspicious → reject for rule fallback
  if (level === "L3" && riskEstimate === "LOW" && !requiresWrite && !requiresExternalAction && taskType === "CHAT") {
    return { ok: false, error: "INVALID_CLASSIFICATION", detail: "L3 contradicts CHAT/LOW/no-write" };
  }
  // Contradiction: L0 with write flags
  if (level === "L0" && (requiresWrite || requiresExternalAction || requiresFormalReview)) {
    return { ok: false, error: "INVALID_CLASSIFICATION", detail: "L0 with write/review flags" };
  }

  const value: AiGateClassification = {
    routeLevel: level,
    taskType,
    complexityEstimate,
    riskEstimate: level === "L3" ? "HIGH" : riskEstimate,
    requiresWrite: level === "L0" ? false : requiresWrite,
    requiresExternalAction: level === "L0" ? false : requiresExternalAction,
    requiresFormalReview: level === "L2" || level === "L3" ? true : requiresFormalReview,
    requiresHumanApproval: level === "L3" ? true : requiresHumanApproval,
    confidence,
    reason: upgraded && upgradeReason ? `${reason} [upgraded: ${upgradeReason}]` : reason,
  };

  return { ok: true, value, upgraded, upgradeReason };
}

export function classificationToGateFields(c: AiGateClassification) {
  return {
    routeLevel: c.routeLevel,
    routeReason: c.reason,
    judgeRequired: c.routeLevel === "L2" || c.routeLevel === "L3",
    suggestedComplexity: c.complexityEstimate,
    suggestedRiskLevel: c.riskEstimate,
    requiresHumanApproval: c.requiresHumanApproval || c.routeLevel === "L3",
    requiresWrite: c.requiresWrite,
    requiresExternalAction: c.requiresExternalAction,
    requiresFormalReview: c.requiresFormalReview || c.routeLevel === "L2" || c.routeLevel === "L3",
    taskType: c.taskType,
    confidence: c.confidence,
  };
}
