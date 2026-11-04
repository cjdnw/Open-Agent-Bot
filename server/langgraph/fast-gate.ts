/**
 * Fast Gate compatibility shim.
 * Classification now goes through AI Gate (Gemini → Rule Fallback).
 * `evaluateFastGate` remains the deterministic rule engine for tests/fallback.
 */
export { evaluateFastGate, ruleFallbackClassify } from "./gate/rule-fallback.ts";
export type { MessageContext } from "./gate/types.ts";
