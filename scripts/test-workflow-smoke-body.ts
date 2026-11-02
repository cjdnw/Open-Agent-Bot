import {
  canTransition,
  hashArtifact,
  parseFinalReview,
  parseMomoPlan,
  parsePreReview,
  validateFinalBinding,
} from "../server/workflow.ts";
import { startWorkflow, type WorkflowDeps } from "../server/workflow-orchestrator.ts";

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    ok += 1;
    console.log("PASS", name);
  } else {
    fail += 1;
    console.log("FAIL", name);
  }
}

check("happy-path edge", canTransition("CREATED", "PRE_REVIEW"));
check("no-skip-exec", !canTransition("CREATED", "EXECUTING"));

const pre = parsePreReview(
  JSON.stringify({
    complexity: "SIMPLE",
    riskLevel: "HIGH",
    reasoningRecommendation: "XHIGH",
    difficultyReason: "destructive but small",
    acceptanceCriteria: ["need approval"],
    requiresUserAuthorization: true,
    recommendedRoles: [],
    requiredEvidence: [],
    riskWarnings: ["prod"],
  }),
  "t",
  false,
);
check("simple+high+xhigh-downgrade", Boolean(pre && pre.complexity === "SIMPLE" && pre.riskLevel === "HIGH" && pre.reasoningEffective === "HIGH"));
check("momo-self", parseMomoPlan('{"decision":"SELF","reason":"easy"}')?.decision === "SELF");

const h = await hashArtifact(["z"]);
const stale = parseFinalReview(
  JSON.stringify({ verdict: "PASS", reason: "ok", criteriaVersion: "c", artifactHash: "bad" }),
  "c",
  h,
)!;
check("stale-pass-blocked", validateFinalBinding(stale, "c", h).verdict === "BLOCKED");

const events: Array<{ stage: string; summary: string }> = [];
const bots = [
  { id: "momo", name: "Momo", threadId: "tm", busy: false },
  { id: "judge", name: "Judge", threadId: "tj", busy: false },
];
const deps: WorkflowDeps = {
  findBotByName: (n) => bots.find((b) => b.name.toLowerCase() === n.toLowerCase()),
  findBotById: (id) => bots.find((b) => b.id === id),
  listVisibleTeam: (except) => bots.filter((b) => b.id !== except),
  canXHighForBot: () => false,
  setBusy: () => {},
  postWorkflowEvent: (_t, e) => events.push({ stage: e.stage, summary: e.summary }),
  postText: () => {},
  persistRun: () => {},
  runBotTurn: async (botId, prompt) => {
    if (botId === "judge" && prompt.includes("最终评审")) {
      const hashes = [...prompt.matchAll(/artifactHash=([a-f0-9]+)/g)].map((x) => x[1]);
      const crits = [...prompt.matchAll(/criteriaVersion=([^\s\n]+)/g)].map((x) => x[1]);
      return {
        ok: true,
        text: JSON.stringify({
          verdict: "PASS",
          reason: "ok",
          criteriaVersion: crits.at(-1),
          artifactHash: hashes.at(-1),
          evidenceGaps: [],
        }),
      };
    }
    if (botId === "judge" && prompt.includes("任务前置评估")) {
      return {
        ok: true,
        text: JSON.stringify({
          complexity: "SIMPLE",
          riskLevel: "LOW",
          reasoningRecommendation: "HIGH",
          difficultyReason: "trivial",
          acceptanceCriteria: ["done"],
          requiredEvidence: ["reply"],
          riskWarnings: [],
          requiresUserAuthorization: false,
          recommendedRoles: [],
        }),
      };
    }
    if (botId === "momo" && prompt.includes("自主决定")) {
      return { ok: true, text: JSON.stringify({ decision: "SELF", reason: "easy", delegateBotNames: [] }) };
    }
    if (botId === "momo" && prompt.includes("正在执行")) {
      return { ok: true, text: "done with evidence" };
    }
    return { ok: false, text: "", error: `unexpected:${botId}:${prompt.slice(0, 40)}` };
  },
};

await startWorkflow(deps, { momoBotId: "momo", userRequest: "fix typo" });
for (let i = 0; i < 100; i++) {
  if (events.some((e) => e.stage === "COMPLETED" || e.stage === "BLOCKED" || e.stage === "FAILED")) break;
  await new Promise((r) => setTimeout(r, 20));
}
check("orchestrator-completed", events.some((e) => e.stage === "COMPLETED"));
check("orchestrator-had-pre", events.some((e) => e.stage === "PRE_REVIEW"));

console.log(JSON.stringify({ ok, fail, events }, null, 2));
if (fail) process.exit(1);
