import { describe, expect, it } from "vitest";
import {
  assertNoComposer,
  BAILIAN_V41_FLASH_MODEL,
  buildAttemptPlan,
  classifyFailure,
  isRetryableFailure,
  nextAfterFailure,
  normalizeRouting,
  quotaPoolFor,
  resolveEffort,
  resolveFinalFallbackPolicy,
  selectNinebotV41Flash,
  shouldSkipPool,
  type ModelCandidate,
} from "./model-fallback.ts";

describe("classifyFailure", () => {
  it("detects quota vs 429 vs auth vs code errors", () => {
    expect(classifyFailure("You've exceeded your usage limit")).toBe("quota_exhausted");
    expect(classifyFailure("HTTP 429 Too Many Requests")).toBe("rate_limit");
    expect(classifyFailure("503 Service Unavailable")).toBe("service_unavailable");
    expect(classifyFailure("ETIMEDOUT connecting")).toBe("network_timeout");
    expect(classifyFailure("Unauthorized — not signed in")).toBe("auth_invalid");
    expect(classifyFailure("Invalid API key")).toBe("api_key_invalid");
    expect(classifyFailure("model not found: foo")).toBe("model_not_found");
    expect(classifyFailure("stopped by user")).toBe("user_abort");
    expect(classifyFailure("TypeError: cannot read property")).toBe("code_error");
  });
});

describe("retry + pool skip", () => {
  it("does not retry code errors or user abort", () => {
    expect(isRetryableFailure("code_error")).toBe(false);
    expect(isRetryableFailure("user_abort")).toBe(false);
    expect(isRetryableFailure("quota_exhausted")).toBe(true);
    expect(shouldSkipPool("quota_exhausted")).toBe(true);
    expect(shouldSkipPool("rate_limit")).toBe(false);
  });

  it("skips same pool after quota exhaustion", () => {
    const plan: ModelCandidate[] = [
      { instanceId: "cursor", model: "grok-4.7" },
      { instanceId: "cursor", model: "claude-sonnet" }, // same P3
      { instanceId: "deepseek-aliyun", model: "kimi/kimi-k2.8-preview" },
    ];
    const r = nextAfterFailure(plan, 0, "quota_exhausted", "skip_pool_on_quota");
    expect(r.nextIndex).toBe(2);
    expect([...r.skipPools]).toContain("P3_cursor");
  });

  it("stops on user abort", () => {
    const plan: ModelCandidate[] = [
      { instanceId: "codex", model: "a" },
      { instanceId: "claude", model: "b" },
    ];
    expect(nextAfterFailure(plan, 0, "user_abort", "skip_pool_on_quota").nextIndex).toBeNull();
  });
});

describe("normalizeRouting + composer ban", () => {
  it("keeps primary from modelSelection when routing absent", () => {
    const r = normalizeRouting(undefined, { instanceId: "codex", model: "gpt-6.1-sol" });
    expect(r.enabled).toBe(false);
    expect(r.primary).toEqual({ instanceId: "codex", model: "gpt-6.1-sol" });
    expect(r.defaultEffort).toBe("high");
  });

  it("strips composer-2.5 candidates", () => {
    const r = normalizeRouting(
      {
        enabled: true,
        primary: { instanceId: "cursor", model: "grok-4.7" },
        fallbacks: [{ instanceId: "cursor", model: "composer-2.5" }],
        defaultEffort: "high",
      },
      { instanceId: "cursor", model: "grok-4.7" },
    );
    expect(r.fallbacks).toEqual([]);
    expect(assertNoComposer(r)).toEqual([]);
  });
});

describe("buildAttemptPlan", () => {
  it("skips unavailable and capability-mismatched candidates", () => {
    const routing = normalizeRouting(
      {
        enabled: true,
        primary: { instanceId: "cursor", model: "grok-4.7" },
        fallbacks: [
          { instanceId: "deepseek-aliyun", model: "kimi/kimi-k2.8-preview", requireAgentsMcp: true },
          { instanceId: "codex", model: "gpt-6.1-terra" },
        ],
        maxAttempts: 5,
      },
      { instanceId: "cursor", model: "grok-4.7" },
    );
    const { plan, skipped } = buildAttemptPlan(routing, (c) => {
      if (c.instanceId === "deepseek-aliyun") {
        return { available: true, agentsMcp: false };
      }
      return { available: true, agentsMcp: true };
    });
    expect(plan.map((p) => p.model)).toEqual(["grok-4.7", "gpt-6.1-terra"]);
    expect(skipped.some((s) => s.reason.includes("agents MCP"))).toBe(true);
  });
});

describe("resolveEffort honesty", () => {
  it("does not claim xhigh when unsupported", () => {
    const r = resolveEffort("xhigh", true, false);
    expect(r.claimedXHigh).toBe(false);
    expect(r.effort).toBe("high");
    expect(r.note).toMatch(/XHigh/);
  });

  it("claims xhigh only when supported", () => {
    const r = resolveEffort("xhigh", true, true);
    expect(r.claimedXHigh).toBe(true);
    expect(r.effort).toBe("xhigh");
  });
});

describe("quota pools", () => {
  it("maps known instance ids", () => {
    expect(quotaPoolFor("codex")).toBe("P1_codex");
    expect(quotaPoolFor("claude")).toBe("P2_anthropic");
    expect(quotaPoolFor("cursor")).toBe("P3_cursor");
    expect(quotaPoolFor("antigravity")).toBe("P4_antigravity");
    expect(quotaPoolFor("deepseek-aliyun")).toBe("P5_bailian");
    expect(quotaPoolFor("ninebot")).toBe("P6_ninebot");
  });
});

describe("F_final policy", () => {
  it("prefers dated Ninebot V4.1 Flash and never picks V4 Flash", () => {
    expect(
      selectNinebotV41Flash([
        "deepseek-v4-flash-0731",
        "external/deepseek-v4.1-flash",
        "external/deepseek-v4.1-flash-1017",
      ]),
    ).toBe("external/deepseek-v4.1-flash-1017");
    expect(selectNinebotV41Flash(["deepseek-v4-flash-0731", "deepseek-flash"])).toBeNull();
  });

  it("skips Ninebot when no verified V4.1 Flash exists", () => {
    const pol = resolveFinalFallbackPolicy({ ninebotModelIds: ["deepseek-v4-flash-0731"] });
    expect(pol.candidates.map((c) => c.instanceId)).toEqual(["deepseek-aliyun"]);
    expect(pol.candidates[0]?.model).toBe(BAILIAN_V41_FLASH_MODEL);
  });

  it("appends F_final after bot fallbacks and dedups Bailian F1 for QA/Reporter", () => {
    const routing = normalizeRouting(
      {
        enabled: true,
        primary: { instanceId: "antigravity", model: "gemini-3.8-flash-high" },
        fallbacks: [{ instanceId: "deepseek-aliyun", model: BAILIAN_V41_FLASH_MODEL }],
        maxAttempts: 2,
      },
      { instanceId: "antigravity", model: "gemini-3.8-flash-high" },
    );
    const final = resolveFinalFallbackPolicy({
      ninebotModelIds: ["external/deepseek-v4.1-flash-1017"],
      bailianModelIds: [BAILIAN_V41_FLASH_MODEL],
    });
    const { plan, skipped } = buildAttemptPlan(routing, () => ({ available: true }), final);
    expect(plan.map((p) => `${p.instanceId}/${p.model}`)).toEqual([
      "antigravity/gemini-3.8-flash-high",
      `deepseek-aliyun/${BAILIAN_V41_FLASH_MODEL}`,
      "ninebot/external/deepseek-v4.1-flash-1017",
    ]);
    expect(skipped.some((s) => s.reason.includes("dedup") && s.candidate.instanceId === "deepseek-aliyun")).toBe(
      true,
    );
  });

  it("enters F_final after ordinary fallbacks fail; Ninebot success path is first", () => {
    const routing = normalizeRouting(
      {
        enabled: true,
        primary: { instanceId: "codex", model: "gpt-6.1-sol" },
        fallbacks: [{ instanceId: "claude", model: "claude-opus-5-5" }],
        maxAttempts: 2,
      },
      { instanceId: "codex", model: "gpt-6.1-sol" },
    );
    const final = resolveFinalFallbackPolicy({
      ninebotModelIds: ["external/deepseek-v4.1-flash-1017"],
    });
    const { plan } = buildAttemptPlan(routing, () => ({ available: true }), final);
    expect(plan.map((p) => p.instanceId)).toEqual(["codex", "claude", "ninebot", "deepseek-aliyun"]);
    const afterClaude = nextAfterFailure(plan, 1, "service_unavailable", "skip_pool_on_quota");
    expect(plan[afterClaude.nextIndex!]?.instanceId).toBe("ninebot");
  });

  it("skips whole Antigravity pool then lands on Claude P2 for Judge", () => {
    const plan: ModelCandidate[] = [
      { instanceId: "antigravity", model: "gemini-4-argon-high" },
      { instanceId: "antigravity", model: "claude-opus-5-5-high" },
      { instanceId: "claude", model: "claude-opus-5-5" },
      { instanceId: "ninebot", model: "external/deepseek-v4.1-flash-1017" },
    ];
    const r = nextAfterFailure(plan, 0, "quota_exhausted", "skip_pool_on_quota");
    expect(r.nextIndex).toBe(2);
    expect(plan[r.nextIndex!]?.instanceId).toBe("claude");
  });

  it("skips remaining F_final when both finals unavailable", () => {
    const routing = normalizeRouting(
      {
        enabled: true,
        primary: { instanceId: "codex", model: "gpt-6.1-sol" },
        fallbacks: [],
        maxAttempts: 1,
      },
      { instanceId: "codex", model: "gpt-6.1-sol" },
    );
    const final = resolveFinalFallbackPolicy({
      ninebotModelIds: ["external/deepseek-v4.1-flash-1017"],
    });
    const { plan } = buildAttemptPlan(
      routing,
      (c) =>
        c.instanceId === "codex"
          ? { available: true }
          : { available: false, reason: "down" },
      final,
    );
    expect(plan.map((p) => p.instanceId)).toEqual(["codex"]);
    expect(nextAfterFailure(plan, 0, "service_unavailable", "skip_pool_on_quota").nextIndex).toBeNull();
  });

  it("pool exhaustion on Ninebot jumps to Bailian", () => {
    const plan: ModelCandidate[] = [
      { instanceId: "codex", model: "a" },
      { instanceId: "ninebot", model: "external/deepseek-v4.1-flash-1017" },
      { instanceId: "deepseek-aliyun", model: BAILIAN_V41_FLASH_MODEL },
    ];
    const r = nextAfterFailure(plan, 1, "quota_exhausted", "skip_pool_on_quota");
    expect(plan[r.nextIndex!]?.instanceId).toBe("deepseek-aliyun");
  });
});
