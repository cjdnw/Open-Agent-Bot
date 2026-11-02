import { describe, expect, it } from "vitest";
import { startWorkflow, type WorkflowDeps } from "./workflow-orchestrator.ts";
import type { WorkflowRun } from "./workflow.ts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("workflow orchestrator (mock bots)", () => {
  it("SIMPLE → SELF → PASS", async () => {
    const events: string[] = [];
    const texts: string[] = [];
    let momoBusy = false;
    const bots = [
      { id: "momo", name: "Momo", title: "Chief", threadId: "tm", busy: false },
      { id: "judge", name: "Judge", title: "Judge", threadId: "tj", busy: false },
    ];
    const deps: WorkflowDeps = {
      findBotByName: (n) => bots.find((b) => b.name.toLowerCase() === n.toLowerCase()),
      findBotById: (id) => bots.find((b) => b.id === id),
      listVisibleTeam: (except) => bots.filter((b) => b.id !== except),
      canXHighForBot: () => false,
      setBusy: (id, busy) => {
        if (id === "momo") momoBusy = busy;
      },
      postWorkflowEvent: (_t, e) => events.push(e.stage),
      postText: (_t, text) => texts.push(text),
      persistRun: () => {},
      runBotTurn: async (botId, prompt) => {
        if (botId === "judge" && prompt.includes("最终评审")) {
          const hashes = [...prompt.matchAll(/artifactHash=([a-f0-9]+)/g)].map((x) => x[1]);
          const crits = [...prompt.matchAll(/criteriaVersion=([^\s\n]+)/g)].map((x) => x[1]);
          return {
            ok: true,
            text: JSON.stringify({
              verdict: "PASS",
              reason: "criteria met",
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
              taskId: "x",
              complexity: "SIMPLE",
              riskLevel: "LOW",
              reasoningRecommendation: "HIGH",
              difficultyReason: "trivial",
              recommendedRoles: [],
              acceptanceCriteria: ["done"],
              requiredEvidence: ["reply"],
              riskWarnings: [],
              requiresUserAuthorization: false,
            }),
          };
        }
        if (botId === "momo" && prompt.includes("自主决定")) {
          return { ok: true, text: JSON.stringify({ decision: "SELF", reason: "easy", delegateBotNames: [] }) };
        }
        if (botId === "momo" && prompt.includes("正在执行")) {
          return { ok: true, text: "fixed the typo; evidence: reply" };
        }
        return { ok: false, text: "", error: `unexpected prompt for ${botId}` };
      },
    };

    const run = await startWorkflow(deps, { momoBotId: "momo", userRequest: "fix a typo in main.cpp" });
    for (let i = 0; i < 80; i++) {
      await sleep(25);
      if (events.includes("COMPLETED")) break;
    }
    expect(events).toContain("PRE_REVIEW");
    expect(events).toContain("PLAN_DONE");
    expect(events).toContain("FINAL_REVIEW");
    expect(events).toContain("COMPLETED");
    expect(momoBusy).toBe(false);
    expect(texts.some((t) => t.includes("Judge 前置评估"))).toBe(true);
    expect(texts.some((t) => t.includes("已验收"))).toBe(true);
    void run;
  });

  it("HIGH risk forces ESCALATE even if Momo says SELF", async () => {
    const events: string[] = [];
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
      postWorkflowEvent: (_t, e) => events.push(e.stage),
      postText: () => {},
      persistRun: () => {},
      runBotTurn: async (botId, prompt) => {
        if (botId === "judge" && prompt.includes("任务前置评估")) {
          return {
            ok: true,
            text: JSON.stringify({
              complexity: "SIMPLE",
              riskLevel: "HIGH",
              reasoningRecommendation: "HIGH",
              difficultyReason: "destructive",
              acceptanceCriteria: ["need approval"],
              requiresUserAuthorization: true,
              recommendedRoles: [],
              requiredEvidence: [],
              riskWarnings: ["prod delete"],
            }),
          };
        }
        return { ok: true, text: JSON.stringify({ decision: "SELF", reason: "I got this", delegateBotNames: [] }) };
      },
    };
    await startWorkflow(deps, { momoBotId: "momo", userRequest: "rm -rf /data" });
    for (let i = 0; i < 80; i++) {
      await sleep(25);
      if (events.includes("BLOCKED")) break;
    }
    expect(events).toContain("BLOCKED");
    expect(events).not.toContain("EXECUTING");
  });
});

describe("types smoke", () => {
  it("WorkflowRun shape", () => {
    const run = { state: "CREATED" } as WorkflowRun;
    expect(run.state).toBe("CREATED");
  });
});
