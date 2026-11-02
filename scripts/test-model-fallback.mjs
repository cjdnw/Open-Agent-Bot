#!/usr/bin/env node
/** Standalone mock tests for model-fallback (no vitest / no paid calls). */
import {
  assertNoComposer,
  buildAttemptPlan,
  classifyFailure,
  isRetryableFailure,
  nextAfterFailure,
  normalizeRouting,
  quotaPoolFor,
  resolveEffort,
  shouldSkipPool,
} from "../dist-server-deploy/model-fallback.js";

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`);
  }
}

check("primary ok path uses primary first", (() => {
  const r = normalizeRouting(
    { enabled: true, primary: { instanceId: "codex", model: "gpt-6.1-sol" }, fallbacks: [{ instanceId: "claude", model: "claude-opus-5-5" }] },
    { instanceId: "codex", model: "gpt-6.1-sol" },
  );
  const { plan } = buildAttemptPlan(r, () => ({ available: true }));
  return plan[0].model === "gpt-6.1-sol";
})());

check("quota exhausted switches to F1", (() => {
  const plan = [
    { instanceId: "codex", model: "a" },
    { instanceId: "antigravity", model: "b" },
  ];
  return nextAfterFailure(plan, 0, "quota_exhausted", "skip_pool_on_quota").nextIndex === 1;
})());

check("F1 fail then F2", (() => {
  const plan = [
    { instanceId: "codex", model: "a" },
    { instanceId: "antigravity", model: "b" },
    { instanceId: "claude", model: "c" },
  ];
  return nextAfterFailure(plan, 1, "service_unavailable", "skip_pool_on_quota").nextIndex === 2;
})());

check("same pool skipped after quota", (() => {
  const plan = [
    { instanceId: "cursor", model: "grok-4.7" },
    { instanceId: "cursor", model: "other" },
    { instanceId: "deepseek-aliyun", model: "kimi" },
  ];
  const r = nextAfterFailure(plan, 0, "quota_exhausted", "skip_pool_on_quota");
  return r.nextIndex === 2 && r.skipPools.has("P3_cursor");
})());

check("auth invalid reports non-retryable", (() => {
  const k = classifyFailure("Unauthorized — not signed in");
  return k === "auth_invalid" && !isRetryableFailure(k);
})());

check("user abort stops fallback", (() => {
  const plan = [
    { instanceId: "codex", model: "a" },
    { instanceId: "claude", model: "b" },
  ];
  return nextAfterFailure(plan, 0, "user_abort", "skip_pool_on_quota").nextIndex === null;
})());

check("side-effect policy: code errors not retryable", () => !isRetryableFailure(classifyFailure("TypeError: boom")));

check("fallback does not rewrite permanent primary in normalize", (() => {
  const sel = { instanceId: "cursor", model: "grok-4.7" };
  const r = normalizeRouting(
    {
      enabled: true,
      primary: { instanceId: "cursor", model: "grok-4.7" },
      fallbacks: [{ instanceId: "codex", model: "gpt-6.1-terra" }],
    },
    sel,
  );
  return sel.model === "grok-4.7" && r.primary.model === "grok-4.7";
})());

check("xhigh honesty: unsupported does not claim xhigh", (() => {
  const r = resolveEffort("xhigh", true, false);
  return r.claimedXHigh === false && r.effort === "high";
})());

check("composer-2.5 stripped", (() => {
  const r = normalizeRouting(
    {
      enabled: true,
      primary: { instanceId: "cursor", model: "grok-4.7" },
      fallbacks: [{ instanceId: "cursor", model: "composer-2.5" }],
    },
    { instanceId: "cursor", model: "grok-4.7" },
  );
  return r.fallbacks.length === 0 && assertNoComposer(r).length === 0;
})());

check("429 is rate_limit not always quota", classifyFailure("HTTP 429 Too Many Requests") === "rate_limit");
check("quota skip pool helper", shouldSkipPool("quota_exhausted") && !shouldSkipPool("rate_limit"));
check("pools mapped", quotaPoolFor("ninebot") === "P6_ninebot" && quotaPoolFor("deepseek-aliyun") === "P5_bailian");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
