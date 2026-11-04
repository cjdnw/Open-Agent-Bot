/**
 * AI Gate orchestrator: Gemini 3.8 Flash High first, Rule Fallback on any failure.
 * Never uses Bot F_final or other LLMs for Gate classification.
 */
import { classificationToGateFields } from "./schema.ts";
import { ruleFallbackClassify } from "./rule-fallback.ts";
import { classifyWithGeminiFlash } from "./gemini-classifier.ts";
import {
  AI_GATE_MODEL_ID,
  gateConfig,
  type GateAuditRecord,
  type GateFailureReason,
  type GateResult,
  type MessageContext,
} from "./types.ts";

export type AiGateDeps = {
  /** Optional injectable classifier for tests / offline mode. */
  classifyWithGemini?: typeof classifyWithGeminiFlash;
};

function fromRule(
  userRequest: string,
  history: MessageContext[] | undefined,
  taskId: string,
  failure: GateFailureReason | null,
  elapsedMs: number,
  validationStatus: GateAuditRecord["validationStatus"] = "SKIPPED",
): GateResult {
  const c = ruleFallbackClassify(userRequest, history);
  const fields = classificationToGateFields(c);
  const audit: GateAuditRecord = {
    taskId,
    classifierSource: "RULE_FALLBACK",
    modelId: null,
    routeLevel: fields.routeLevel,
    routeReason: fields.routeReason,
    riskLevel: fields.suggestedRiskLevel,
    validationStatus,
    fallbackReason: failure,
    elapsedMs,
    timestamp: Date.now(),
    confidence: 1,
    taskType: fields.taskType,
  };
  return { ...fields, audit };
}

/**
 * Classify a user message for LangGraph routing.
 */
export async function runAiGate(
  input: {
    taskId: string;
    userRequest: string;
    history?: MessageContext[];
  },
  deps: AiGateDeps = {},
): Promise<GateResult> {
  const started = Date.now();
  const cfg = gateConfig();

  if (!cfg.enabled) {
    return fromRule(input.userRequest, input.history, input.taskId, "DISABLED", Date.now() - started, "SKIPPED");
  }

  const classify = deps.classifyWithGemini || classifyWithGeminiFlash;
  let geminiResult: Awaited<ReturnType<typeof classifyWithGeminiFlash>>;
  try {
    geminiResult = await classify(input.userRequest, input.history, {
      timeoutMs: cfg.timeoutMs,
      modelId: cfg.modelId,
      cli: cfg.cli,
    });
  } catch {
    return fromRule(
      input.userRequest,
      input.history,
      input.taskId,
      "UNKNOWN_ERROR",
      Date.now() - started,
      "REJECTED",
    );
  }

  if (!geminiResult.ok) {
    return fromRule(
      input.userRequest,
      input.history,
      input.taskId,
      geminiResult.failure,
      geminiResult.elapsedMs || Date.now() - started,
      "REJECTED",
    );
  }

  const fields = classificationToGateFields(geminiResult.classification);
  const audit: GateAuditRecord = {
    taskId: input.taskId,
    classifierSource: "GEMINI",
    modelId: geminiResult.modelId || AI_GATE_MODEL_ID,
    routeLevel: fields.routeLevel,
    routeReason: fields.routeReason,
    riskLevel: fields.suggestedRiskLevel,
    // Schema may deterministically upgrade under-classified writes; still Gemini-sourced.
    validationStatus: "OK",
    fallbackReason: null,
    elapsedMs: geminiResult.elapsedMs || Date.now() - started,
    timestamp: Date.now(),
    confidence: fields.confidence,
    taskType: fields.taskType,
  };
  return { ...fields, audit };
}

export { ruleFallbackClassify, evaluateFastGate } from "./rule-fallback.ts";
export { parseAndValidateGateJson } from "./schema.ts";
export { classifyWithGeminiFlash, probeAiGateModel } from "./gemini-classifier.ts";
export { AI_GATE_SYSTEM_PROMPT } from "./prompt.ts";
export * from "./types.ts";
