#!/usr/bin/env node
import {
  buildAttemptPlan,
  nextAfterFailure,
  normalizeRouting,
  quotaPoolFor,
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

const routing = normalizeRouting(
  {
    enabled: true,
    primary: { instanceId: "antigravity", model: "gemini-4-argon-high" },
    fallbacks: [
      { instanceId: "antigravity", model: "claude-opus-5-5-high" },
      { instanceId: "codex", model: "gpt-6.1-sol" },
    ],
    defaultEffort: "high",
    maxAttempts: 3,
    cooldownPolicy: "skip_pool_on_quota",
  },
  { instanceId: "antigravity", model: "gemini-4-argon-high" },
);

const { plan } = buildAttemptPlan(routing, () => ({ available: true }));
check("plan order primary→F1→F2", plan.map((p) => p.model).join(">") === "gemini-4-argon-high>claude-opus-5-5-high>gpt-6.1-sol");
check("pools P4/P4/P1", quotaPoolFor(plan[0].instanceId) === "P4_antigravity" && quotaPoolFor(plan[1].instanceId) === "P4_antigravity" && quotaPoolFor(plan[2].instanceId) === "P1_codex");

// 1) primary success → no fallback needed (implied by nextAfterFailure not called)
check("primary success keeps permanent selection untouched", routing.primary.model === "gemini-4-argon-high");

// 2) Gemini single-model failure (service) → F1 Opus on same pool OK
{
  const r = nextAfterFailure(plan, 0, "service_unavailable", "skip_pool_on_quota");
  check("Gemini model fault → F1 Antigravity Opus", r.nextIndex === 1 && plan[r.nextIndex].model === "claude-opus-5-5-high");
}

// 3) Antigravity pool quota exhausted → skip F1, go Codex
{
  const r = nextAfterFailure(plan, 0, "quota_exhausted", "skip_pool_on_quota");
  check("P4 quota exhausted → skip F1 to Codex", r.nextIndex === 2 && plan[r.nextIndex].model === "gpt-6.1-sol" && r.skipPools.has("P4_antigravity"));
}

// 4) Codex F2 fails → no more
{
  const r = nextAfterFailure(plan, 2, "service_unavailable", "skip_pool_on_quota");
  check("Codex F2 fail → report exhausted", r.nextIndex === null);
}

check("composer-2.5 absent", !JSON.stringify(routing).includes("composer-2.5"));
check("defaultEffort high", routing.defaultEffort === "high");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
