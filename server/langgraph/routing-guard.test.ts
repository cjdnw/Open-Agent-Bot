import { describe, expect, it } from "vitest";
import { buildLangGraphWorkflow } from "./graph.ts";
import {
  detectDependencyCycle,
  momoPlanToRoutingDecision,
  validateMomoRouting,
} from "./routing-guard.ts";
import {
  buildWorkerCapabilities,
  lookupWorkersForTask,
  scoreWorkerForTask,
} from "./worker-registry.ts";
import type { WorkflowDeps } from "./types.ts";
import type { PreReview } from "../workflow.ts";
import { parseMomoPlan, parsePreReview } from "../workflow.ts";

const basePre = (over: Partial<PreReview> = {}): PreReview => ({
  taskId: "t1",
  complexity: "MODERATE",
  riskLevel: "MEDIUM",
  reasoningRecommendation: "HIGH",
  reasoningEffective: "HIGH",
  difficultyReason: "code change",
  recommendedRoles: ["Developer"],
  roleReasons: { Developer: "需要修改 C++ 源码" },
  acceptanceCriteria: ["仅修改指定文件", "提供 Diff"],
  requiredEvidence: ["git diff"],
  riskWarnings: [],
  requiresUserAuthorization: false,
  at: Date.now(),
  ...over,
});

const team = [
  { id: "dev", name: "Developer", title: "C++ Engineer", busy: false },
  { id: "qa", name: "QA", title: "Tester", busy: false },
  { id: "dep", name: "Deploy", title: "RK3576", busy: false },
  { id: "arc", name: "Architect", busy: false },
  { id: "rep", name: "Reporter", busy: false },
];

describe("WorkerRegistry", () => {
  it("binds botId from live team and reports availability", () => {
    const caps = buildWorkerCapabilities([
      ...team,
      { id: "busy-dev", name: "DeveloperAlt", title: "Developer", busy: true },
    ]);
    expect(caps.some((c) => c.role === "Developer" && c.botId === "dev")).toBe(true);
    const lookup = lookupWorkersForTask(team, "修改 main.cpp 网络逻辑", ["Developer"]);
    expect(lookup.matchReasons[0]?.matched).toBe(true);
  });

  it("rejects SSH task for workers without ssh ops", () => {
    const caps = buildWorkerCapabilities([{ id: "qa", name: "QA", busy: false }]);
    const qa = caps[0]!;
    const scored = scoreWorkerForTask(qa, "ssh 到板子部署", [], ["ssh"]);
    expect(scored.matched).toBe(false);
  });

  it("OFFLINE and BUSY have distinct rejection reasons", () => {
    const offline = buildWorkerCapabilities([{ id: "d", name: "Deploy", offline: true }])[0]!;
    const busy = buildWorkerCapabilities([{ id: "q", name: "QA", busy: true }])[0]!;
    expect(scoreWorkerForTask(offline, "deploy", [], []).reason).toMatch(/OFFLINE/);
    expect(scoreWorkerForTask(busy, "test", [], []).reason).toMatch(/BUSY/);
  });
});

describe("RoutingGuard unit rules", () => {
  const registry = lookupWorkersForTask(team, "修改 cpp", ["Developer", "QA"]);

  it("1. valid SELF executes without forcing Judge roles", () => {
    const r = validateMomoRouting({
      decision: {
        executionMode: "SELF",
        selectedRoles: [],
        decisionReason: "单文件可自干",
        requestedEffort: "HIGH",
        at: Date.now(),
      },
      preReview: basePre({ recommendedRoles: ["Developer", "QA"] }),
      registry,
      userRequest: "改一行注释",
      retryCount: 0,
    });
    expect(r.status).toBe("VALID");
    expect(r.executionMode).toBe("SELF");
    expect(r.fallbackApplied).toBe(false);
    expect(r.routingSource).toBe("MOMO");
  });

  it("2. valid DELEGATE resolves real workers", () => {
    const r = validateMomoRouting({
      decision: {
        executionMode: "DELEGATE",
        selectedRoles: ["Developer"],
        decisionReason: "需要写代码",
        requestedEffort: "HIGH",
        at: Date.now(),
      },
      preReview: basePre(),
      registry,
      userRequest: "修改 cpp",
      retryCount: 0,
    });
    expect(r.status).toBe("VALID");
    expect(r.resolvedWorkers[0]?.botId).toBe("dev");
  });

  it("3. multi-worker dependency order accepted when acyclic", () => {
    const r = validateMomoRouting({
      decision: {
        executionMode: "DELEGATE",
        selectedRoles: ["Developer", "QA"],
        decisionReason: "开发后验证",
        requestedEffort: "HIGH",
        taskAssignments: [
          { role: "Developer", objective: "改代码" },
          { role: "QA", objective: "测", dependsOn: ["Developer"] },
        ],
        at: Date.now(),
      },
      preReview: basePre({ recommendedRoles: ["Developer", "QA"] }),
      registry,
      userRequest: "改代码并测试",
      retryCount: 0,
    });
    expect(r.status).toBe("VALID");
    expect(detectDependencyCycle(r.taskAssignments)).toBe(false);
  });

  it("4. missing decision requests one retry", () => {
    const r = validateMomoRouting({
      decision: null,
      preReview: basePre(),
      registry,
      userRequest: "改代码",
      retryCount: 0,
    });
    expect(r.status).toBe("RETRY");
    expect(r.retryRequested).toBe(true);
  });

  it("5. retry exhausted applies RoutingGuard fallback and records source", () => {
    const r = validateMomoRouting({
      decision: null,
      preReview: basePre({ recommendedRoles: ["Developer"] }),
      registry,
      userRequest: "修改 cpp",
      retryCount: 1,
    });
    expect(r.status).toBe("FALLBACK");
    expect(r.routingSource).toBe("ROUTING_GUARD");
    expect(r.fallbackApplied).toBe(true);
    expect(r.selectedRoles).toEqual(["Developer"]);
    expect(r.reason).toMatch(/RoutingGuard/);
  });

  it("7. unknown worker is rejected (retry then blocked)", () => {
    const first = validateMomoRouting({
      decision: {
        executionMode: "DELEGATE",
        selectedRoles: ["GhostBot"],
        decisionReason: "x",
        requestedEffort: "HIGH",
        at: Date.now(),
      },
      preReview: basePre(),
      registry,
      userRequest: "改代码",
      retryCount: 0,
    });
    expect(first.status).toBe("RETRY");
    const second = validateMomoRouting({
      decision: {
        executionMode: "DELEGATE",
        selectedRoles: ["GhostBot"],
        decisionReason: "x",
        requestedEffort: "HIGH",
        at: Date.now(),
      },
      preReview: basePre(),
      registry,
      userRequest: "改代码",
      retryCount: 1,
    });
    expect(second.status).toBe("BLOCKED");
  });

  it("8/9. OFFLINE/BUSY workers are not scheduled", () => {
    const busyReg = lookupWorkersForTask(
      [{ id: "dev", name: "Developer", busy: true }],
      "改代码",
      ["Developer"],
    );
    const r = validateMomoRouting({
      decision: {
        executionMode: "DELEGATE",
        selectedRoles: ["Developer"],
        decisionReason: "x",
        requestedEffort: "HIGH",
        at: Date.now(),
      },
      preReview: basePre(),
      registry: busyReg,
      userRequest: "改代码",
      retryCount: 1,
    });
    expect(["BLOCKED", "ESCALATE", "FALLBACK"]).toContain(r.status);
    expect(r.resolvedWorkers.some((w) => w.botId === "dev")).toBe(false);
  });

  it("11. unauthorized high-risk forces ESCALATE even for SELF", () => {
    const r = validateMomoRouting({
      decision: {
        executionMode: "SELF",
        selectedRoles: [],
        decisionReason: "我来删库",
        requestedEffort: "HIGH",
        at: Date.now(),
      },
      preReview: basePre({
        riskLevel: "HIGH",
        requiresUserAuthorization: true,
        recommendedRoles: ["Deploy"],
      }),
      registry,
      userRequest: "删除生产数据",
      approvalGranted: null,
      retryCount: 0,
    });
    expect(r.status).toBe("ESCALATE");
  });

  it("12. dependency cycle is rejected", () => {
    expect(
      detectDependencyCycle([
        { role: "Developer", objective: "a", dependsOn: ["QA"] },
        { role: "QA", objective: "b", dependsOn: ["Developer"] },
      ]),
    ).toBe(true);
    const r = validateMomoRouting({
      decision: {
        executionMode: "DELEGATE",
        selectedRoles: ["Developer", "QA"],
        decisionReason: "loop",
        requestedEffort: "HIGH",
        taskAssignments: [
          { role: "Developer", objective: "a", dependsOn: ["QA"] },
          { role: "QA", objective: "b", dependsOn: ["Developer"] },
        ],
        at: Date.now(),
      },
      preReview: basePre({ recommendedRoles: ["Developer", "QA"] }),
      registry,
      userRequest: "改代码",
      retryCount: 0,
    });
    expect(r.status).toBe("INVALID");
    expect(r.retryRequested).toBe(true);
  });

  it("13. ambiguous fallback escalates; empty pool blocks", () => {
    const empty = lookupWorkersForTask([], "改代码", ["Developer"]);
    const blocked = validateMomoRouting({
      decision: null,
      preReview: basePre({ recommendedRoles: ["Developer"] }),
      registry: empty,
      userRequest: "改代码",
      retryCount: 1,
    });
    expect(blocked.status).toBe("BLOCKED");

    const multi = validateMomoRouting({
      decision: null,
      preReview: basePre({ recommendedRoles: ["Developer", "QA"] }),
      registry,
      userRequest: "复杂任务",
      retryCount: 1,
    });
    // Two recommended available roles → cannot pick uniquely
    expect(["ESCALATE", "FALLBACK"]).toContain(multi.status);
  });

  it("parses extended Momo/Judge JSON shapes", () => {
    const pre = parsePreReview(
      JSON.stringify({
        taskId: "t",
        complexity: "MODERATE",
        riskLevel: "MEDIUM",
        reasoningRecommendation: "HIGH",
        difficultyReason: "x",
        recommendedRoles: ["Developer", "QA"],
        roleReasons: { Developer: "改代码", QA: "验证" },
        acceptanceCriteria: ["diff"],
        requiredEvidence: [],
        riskWarnings: [],
        requiresUserAuthorization: false,
      }),
      "t",
      false,
    );
    expect(pre?.roleReasons?.Developer).toBe("改代码");
    const plan = parseMomoPlan(
      JSON.stringify({
        executionMode: "DELEGATE",
        decisionReason: "需要两人",
        selectedRoles: ["Developer", "QA"],
        requestedEffort: "HIGH",
        taskAssignments: [{ role: "QA", objective: "测", dependsOn: ["Developer"] }],
      }),
    );
    expect(plan?.decision).toBe("DELEGATE");
    expect(plan?.delegateBotNames).toEqual(["Developer", "QA"]);
    expect(momoPlanToRoutingDecision(plan)?.selectedRoles).toEqual(["Developer", "QA"]);
  });
});

describe("RoutingGuard in LangGraph (formal path still ends at Judge Final)", () => {
  it("17. fallback DELEGATE still reaches Judge Final Review", async () => {
    const events: string[] = [];
    let momoPlans = 0;
    const bots = [
      { id: "momo", name: "Momo", threadId: "tm", busy: false },
      { id: "judge", name: "Judge", threadId: "tj", busy: false },
      { id: "dev", name: "Developer", threadId: "td", busy: false },
    ];
    const deps: WorkflowDeps = {
      findBotByName: (n) => bots.find((b) => b.name.toLowerCase() === n.toLowerCase()),
      findBotById: (id) => bots.find((b) => b.id === id),
      listVisibleTeam: (except) => bots.filter((b) => b.id !== except),
      canXHighForBot: () => false,
      setBusy: () => {},
      postWorkflowEvent: (_t, e) => events.push(e.stage),
      postText: () => {},
      runBotTurn: async (botId, prompt) => {
        if (botId === "judge" && prompt.includes("任务前置评估")) {
          return {
            ok: true,
            text: JSON.stringify({
              taskId: "t",
              complexity: "MODERATE",
              riskLevel: "MEDIUM",
              reasoningRecommendation: "HIGH",
              difficultyReason: "code",
              recommendedRoles: ["Developer"],
              roleReasons: { Developer: "改 cpp" },
              acceptanceCriteria: ["diff"],
              requiredEvidence: ["git diff"],
              riskWarnings: [],
              requiresUserAuthorization: false,
            }),
          };
        }
        if (botId === "judge") {
          return {
            ok: true,
            text: JSON.stringify({
              verdict: "PASS",
              reason: "ok",
              criteriaVersion: "will-bind",
              artifactHash: "will-bind",
              evidenceGaps: [],
            }),
          };
        }
        if (botId === "momo" && prompt.includes("请自主决定怎么做")) {
          momoPlans++;
          return { ok: true, text: "not-json" };
        }
        return { ok: true, text: "worker/momo done" };
      },
    };

    const graph = buildLangGraphWorkflow(deps);
    const res = await graph.invoke({
      workflowId: "wf-rg",
      threadId: "tm",
      momoBotId: "momo",
      judgeBotId: "judge",
      userRequest: "修改 main.cpp 删除 PConv 保留 M1",
      reworkCount: 0,
      errors: [],
      history: [],
    });

    expect(momoPlans).toBe(2); // initial + one retry
    expect(events).toContain("WORKER_REGISTRY");
    expect(events).toContain("ROUTING_GUARD");
    expect(events).toContain("FINAL_REVIEW");
    expect(res.routingSource).toBe("ROUTING_GUARD");
    expect(res.executionMode).toBe("DELEGATE");
  });

  it("L0 hello still skips Judge and WorkerRegistry scheduling", async () => {
    const events: string[] = [];
    const deps: WorkflowDeps = {
      findBotByName: () => ({ id: "momo", name: "Momo", threadId: "tm", busy: false }),
      findBotById: () => ({ id: "momo", name: "Momo", threadId: "tm", busy: false }),
      listVisibleTeam: () => [],
      canXHighForBot: () => false,
      setBusy: () => {},
      postWorkflowEvent: (_t, e) => events.push(e.stage),
      postText: () => {},
      runBotTurn: async () => ({ ok: true, text: "Hello!" }),
    };
    const graph = buildLangGraphWorkflow(deps);
    const res = await graph.invoke({
      workflowId: "wf-l0",
      threadId: "tm",
      momoBotId: "momo",
      judgeBotId: "judge",
      userRequest: "hello",
      reworkCount: 0,
      errors: [],
      history: [],
    });
    expect(res.routeLevel).toBe("L0");
    expect(events).not.toContain("WORKER_REGISTRY");
    expect(events).not.toContain("PRE_REVIEW");
    expect(events).not.toContain("ROUTING_GUARD");
  });
});
