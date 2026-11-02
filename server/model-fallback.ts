// Per-bot model routing with safe automatic fallback.
// Does NOT mutate the bot's permanent modelSelection; only selects the next
// candidate for the current turn.
import type { InstanceId, ModelSelection, ReasoningEffort } from "./contracts.ts";

export type QuotaPool = "P1_codex" | "P2_anthropic" | "P3_cursor" | "P4_antigravity" | "P5_bailian" | "P6_ninebot" | "P_unknown";

export type FallbackFailureKind =
  | "quota_exhausted"
  | "rate_limit"
  | "service_unavailable"
  | "network_timeout"
  | "auth_invalid"
  | "api_key_invalid"
  | "model_not_found"
  | "tool_capability_mismatch"
  | "user_abort"
  | "code_error"
  | "unknown";

export interface ModelCandidate {
  instanceId: InstanceId;
  model: string;
  /** Optional human label for activity messages */
  label?: string;
  /** Soft requirement: skip if agents MCP is needed and unavailable */
  requireAgentsMcp?: boolean;
  /** Soft requirement: skip if computer tools are needed */
  requireComputerTools?: boolean;
}

export interface ModelRoutingConfig {
  enabled: boolean;
  primary: ModelCandidate;
  fallbacks: ModelCandidate[];
  defaultEffort: "high" | "xhigh";
  maxAttempts: number;
  cooldownPolicy?: "skip_pool_on_quota" | "none";
}

/** Global last-resort chain after every bot-specific candidate fails. */
export interface FinalFallbackPolicy {
  enabled: boolean;
  /** Prefer High; providers that lack effort control record a note instead of fabricating support. */
  defaultEffort: "high";
  /** Ordered: P6 Ninebot first, then P5 Bailian. Exact model IDs only. */
  candidates: ModelCandidate[];
}

/** Prefer dated Ninebot V4.1 Flash; never treat V4 Flash as V4.1 Flash. */
export const NINEBOT_V41_FLASH_PREFERENCE = [
  "external/deepseek-v4.1-flash-1017",
  "external/deepseek-v4.1-flash",
] as const;

export const BAILIAN_V41_FLASH_MODEL = "deepseek-v4.1-flash-1017";

export function selectNinebotV41Flash(modelIds: readonly string[]): string | null {
  const set = new Set(modelIds);
  for (const id of NINEBOT_V41_FLASH_PREFERENCE) {
    if (set.has(id)) return id;
  }
  return null;
}

export function resolveFinalFallbackPolicy(opts?: {
  enabled?: boolean;
  ninebotModelIds?: readonly string[] | null;
  bailianModelIds?: readonly string[] | null;
}): FinalFallbackPolicy {
  const enabled = opts?.enabled !== false;
  const candidates: ModelCandidate[] = [];
  const ninebotId = selectNinebotV41Flash(opts?.ninebotModelIds ?? NINEBOT_V41_FLASH_PREFERENCE);
  if (ninebotId) {
    candidates.push({
      instanceId: "ninebot",
      model: ninebotId,
      label: `F_final P6 Ninebot ${ninebotId}`,
    });
  }
  const bailianIds = opts?.bailianModelIds;
  const bailianOk =
    !bailianIds || bailianIds.length === 0 || bailianIds.includes(BAILIAN_V41_FLASH_MODEL);
  if (bailianOk) {
    candidates.push({
      instanceId: "deepseek-aliyun",
      model: BAILIAN_V41_FLASH_MODEL,
      label: `F_final P5 Bailian ${BAILIAN_V41_FLASH_MODEL}`,
    });
  }
  return { enabled, defaultEffort: "high", candidates };
}

export const DEFAULT_FINAL_FALLBACK_POLICY: FinalFallbackPolicy = resolveFinalFallbackPolicy({
  ninebotModelIds: NINEBOT_V41_FLASH_PREFERENCE,
});

export interface CandidateCapability {
  available: boolean;
  reason?: string;
  agentsMcp?: boolean;
  computerTools?: boolean;
  reasoningEffort?: boolean;
  supportsXHigh?: boolean;
}

const POOL_BY_INSTANCE: Record<string, QuotaPool> = {
  codex: "P1_codex",
  claude: "P2_anthropic",
  cursor: "P3_cursor",
  antigravity: "P4_antigravity",
  "deepseek-aliyun": "P5_bailian",
  deepseek: "P5_bailian",
  ninebot: "P6_ninebot",
};

export function quotaPoolFor(instanceId: string): QuotaPool {
  return POOL_BY_INSTANCE[instanceId] ?? "P_unknown";
}

export function classifyFailure(message: string): FallbackFailureKind {
  const m = message.toLowerCase();
  if (/\b(aborted|interrupted|cancelled|canceled|user stop|stopped by user)\b/.test(m)) return "user_abort";
  if (/\b(quota|usage.?limit|rate.?limit.?exceeded|billing|insufficient.?credits|out of credits|exceeded your.*limit|5.?hour)\b/.test(m))
    return "quota_exhausted";
  if (/\b(429|too many requests|rate.?limit)\b/.test(m)) return "rate_limit";
  if (/\b(503|502|504|service.?unavailable|overloaded|temporarily unavailable)\b/.test(m)) return "service_unavailable";
  if (/\b(timeout|etimedout|econnreset|network|fetch failed|socket hang up)\b/.test(m)) return "network_timeout";
  if (/\b(unauthorized|unauthenticated|not signed in|login|auth(entication)? failed|forbidden|401)\b/.test(m))
    return "auth_invalid";
  if (/\b(api.?key|invalid.?key|403.*key)\b/.test(m)) return "api_key_invalid";
  if (/\b(model.?not.?found|unknown model|invalid model|404.*model)\b/.test(m)) return "model_not_found";
  if (/\b(tool|mcp|computer|capability).*(not|un)supported|unsupported tool\b/.test(m)) return "tool_capability_mismatch";
  // Ordinary code / shell / compile failures must NOT auto-fallback.
  if (/\b(syntaxerror|typeerror|traceback|exception|compile error|test failed|assertion)\b/.test(m)) return "code_error";
  return "unknown";
}

export function isRetryableFailure(kind: FallbackFailureKind): boolean {
  return (
    kind === "quota_exhausted" ||
    kind === "rate_limit" ||
    kind === "service_unavailable" ||
    kind === "network_timeout" ||
    kind === "model_not_found" ||
    kind === "tool_capability_mismatch"
  );
}

export function shouldSkipPool(kind: FallbackFailureKind): boolean {
  // Exhausted subscription/API pool: do not keep hitting siblings in the same pool.
  return kind === "quota_exhausted";
}

export function normalizeRouting(
  raw: unknown,
  fallbackFromSelection: ModelSelection,
): ModelRoutingConfig {
  const basePrimary: ModelCandidate = {
    instanceId: fallbackFromSelection.instanceId,
    model: fallbackFromSelection.model,
  };
  if (!raw || typeof raw !== "object") {
    return {
      enabled: false,
      primary: basePrimary,
      fallbacks: [],
      defaultEffort: "high",
      maxAttempts: 1,
      cooldownPolicy: "skip_pool_on_quota",
    };
  }
  const o = raw as Record<string, unknown>;
  const primary = decodeCandidate(o.primary) ?? basePrimary;
  const fallbacks = Array.isArray(o.fallbacks)
    ? o.fallbacks.map(decodeCandidate).filter((c): c is ModelCandidate => Boolean(c))
    : [];
  const effort = o.defaultEffort === "xhigh" ? "xhigh" : "high";
  const maxAttempts =
    typeof o.maxAttempts === "number" && o.maxAttempts >= 1
      ? Math.min(8, Math.floor(o.maxAttempts))
      : 1 + fallbacks.length;
  const enabled = o.enabled !== false;
  return {
    enabled,
    primary,
    fallbacks: enabled ? fallbacks : [],
    defaultEffort: effort,
    maxAttempts: enabled ? maxAttempts : 1,
    cooldownPolicy: o.cooldownPolicy === "none" ? "none" : "skip_pool_on_quota",
  };
}

function decodeCandidate(raw: unknown): ModelCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.instanceId !== "string" || !o.instanceId) return null;
  if (typeof o.model !== "string" || !o.model) return null;
  if (o.model === "composer-2.5" || o.model.includes("composer-2.5")) return null;
  return {
    instanceId: o.instanceId,
    model: o.model,
    label: typeof o.label === "string" ? o.label : undefined,
    requireAgentsMcp: o.requireAgentsMcp === true,
    requireComputerTools: o.requireComputerTools === true,
  };
}

export function buildAttemptPlan(
  routing: ModelRoutingConfig,
  caps: (c: ModelCandidate) => CandidateCapability,
  finalPolicy: FinalFallbackPolicy | null = DEFAULT_FINAL_FALLBACK_POLICY,
): { plan: ModelCandidate[]; skipped: Array<{ candidate: ModelCandidate; reason: string }> } {
  const skipped: Array<{ candidate: ModelCandidate; reason: string }> = [];
  const plan: ModelCandidate[] = [];
  const seen = new Set<string>();

  const consider = (c: ModelCandidate, phase: "bot" | "final") => {
    if (c.model === "composer-2.5" || c.model.includes("composer-2.5")) {
      skipped.push({ candidate: c, reason: "composer-2.5 is forbidden" });
      return;
    }
    // Never treat V4 Flash as V4.1 Flash in the final chain.
    if (phase === "final" && /deepseek-v4-flash(?!\.1)/i.test(c.model) && !/v4\.1-flash/i.test(c.model)) {
      skipped.push({ candidate: c, reason: "V4 Flash is not V4.1 Flash" });
      return;
    }
    const key = `${c.instanceId}::${c.model}`;
    if (seen.has(key)) {
      skipped.push({
        candidate: c,
        reason: phase === "final" ? "dedup: already attempted in bot fallbacks" : "dedup",
      });
      return;
    }
    seen.add(key);
    const cap = caps(c);
    if (!cap.available) {
      skipped.push({ candidate: c, reason: cap.reason ?? "unavailable" });
      return;
    }
    if (c.requireAgentsMcp && cap.agentsMcp !== true) {
      skipped.push({ candidate: c, reason: "agents MCP not available" });
      return;
    }
    if (c.requireComputerTools && cap.computerTools !== true) {
      skipped.push({ candidate: c, reason: "computer tools not available" });
      return;
    }
    plan.push(c);
  };

  // Phase 1: bot primary + dedicated fallbacks (capped by maxAttempts).
  for (const c of [routing.primary, ...routing.fallbacks]) {
    const before = plan.length;
    consider(c, "bot");
    if (plan.length > before && plan.length >= routing.maxAttempts) break;
  }

  // Phase 2: global F_final after all normal candidates — never hard-coded per bot.
  if (finalPolicy?.enabled) {
    for (const c of finalPolicy.candidates) consider(c, "final");
  }

  return { plan, skipped };
}

export function nextAfterFailure(
  plan: ModelCandidate[],
  failedIndex: number,
  kind: FallbackFailureKind,
  cooldownPolicy: ModelRoutingConfig["cooldownPolicy"],
): { nextIndex: number | null; skipPools: Set<QuotaPool> } {
  const skipPools = new Set<QuotaPool>();
  if (!isRetryableFailure(kind)) return { nextIndex: null, skipPools };
  if (kind === "user_abort") return { nextIndex: null, skipPools };
  const failed = plan[failedIndex];
  if (failed && cooldownPolicy !== "none" && shouldSkipPool(kind)) {
    skipPools.add(quotaPoolFor(failed.instanceId));
  }
  for (let i = failedIndex + 1; i < plan.length; i++) {
    const pool = quotaPoolFor(plan[i].instanceId);
    if (skipPools.has(pool)) continue;
    return { nextIndex: i, skipPools };
  }
  return { nextIndex: null, skipPools };
}

/** Resolve requested effort against provider capability. Never silently claim xhigh. */
export function resolveEffort(
  requested: ReasoningEffort | "xhigh" | undefined,
  supportsEffort: boolean,
  supportsXHigh: boolean,
): { effort?: ReasoningEffort | "xhigh"; claimedXHigh: boolean; note?: string } {
  const want = requested ?? "high";
  if (want === "xhigh") {
    if (supportsXHigh) return { effort: "xhigh", claimedXHigh: true };
    if (supportsEffort) {
      return {
        effort: "high",
        claimedXHigh: false,
        note: "XHigh requested but unsupported; executed at High",
      };
    }
    return {
      effort: undefined,
      claimedXHigh: false,
      note: "XHigh requested but provider has no effort control; used model default",
    };
  }
  if (want === "high" || want === "medium" || want === "low") {
    if (supportsEffort) return { effort: want, claimedXHigh: false };
    return { effort: undefined, claimedXHigh: false, note: "Effort control unsupported; used model default" };
  }
  return { effort: undefined, claimedXHigh: false };
}

export function assertNoComposer(routing: ModelRoutingConfig): string[] {
  const bad: string[] = [];
  for (const c of [routing.primary, ...routing.fallbacks]) {
    if (c.model === "composer-2.5" || /composer-2\.5/i.test(c.model)) {
      bad.push(`${c.instanceId}/${c.model}`);
    }
  }
  return bad;
}
