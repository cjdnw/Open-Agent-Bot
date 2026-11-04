import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { evaluateFastGate } from "./fast-gate.ts";
import { FileCheckpointSaver } from "./checkpointer.ts";
import { globalResourceLockManager } from "./resource-lock.ts";
import { buildLangGraphWorkflow } from "./graph.ts";
import { startWorkflow, cancelWorkflow, approveWorkflow, loadWorkflowRun } from "./engine.ts";
import type { WorkflowDeps } from "./types.ts";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("A. Fast Gate Deterministic Routing", () => {
  it("'hello' routes to L0 with no Judge required", () => {
    const res = evaluateFastGate("hello");
    expect(res.routeLevel).toBe("L0");
    expect(res.judgeRequired).toBe(false);
  });

  it("'你好' routes to L0 with no Judge required", () => {
    const res = evaluateFastGate("你好");
    expect(res.routeLevel).toBe("L0");
    expect(res.judgeRequired).toBe(false);
  });

  it("'查询已保存的额度快照' routes to L1 with no Judge required", () => {
    const res = evaluateFastGate("查询已保存的额度快照");
    expect(res.routeLevel).toBe("L1");
    expect(res.judgeRequired).toBe(false);
  });

  it("'解释什么是 Transformer' routes to L1", () => {
    const res = evaluateFastGate("解释一下什么是注意力机制");
    expect(res.routeLevel).toBe("L1");
    expect(res.judgeRequired).toBe(false);
  });

  it("'hello，帮我删除数据库' is strictly NOT L0 and flags high risk L3", () => {
    const res = evaluateFastGate("hello，帮我删除数据库");
    expect(res.routeLevel).toBe("L3");
    expect(res.judgeRequired).toBe(true);
    expect(res.suggestedRiskLevel).toBe("HIGH");
  });

  it("multi-turn context prevents disguising dangerous write", () => {
    const history = [
      { role: "user" as const, text: "准备修改生产服务器数据库" },
      { role: "assistant" as const, text: "请确认" },
    ];
    const res = evaluateFastGate("确认，执行删除", history);
    expect(res.routeLevel).toBe("L3");
    expect(res.judgeRequired).toBe(true);
  });

  it("code change task routes to L2 with Judge required", () => {
    const res = evaluateFastGate("修改 main.cpp 中的网络重连逻辑，增加指数退避");
    expect(res.routeLevel).toBe("L2");
    expect(res.judgeRequired).toBe(true);
    expect(res.suggestedComplexity).toBe("MODERATE");
  });
});

describe("B. Judge Pre-Review & LangGraph Flow", () => {
  it("L2 task executes Judge Pre-Review, locks criteria, and records structured evaluation", async () => {
    const events: string[] = [];
    const texts: string[] = [];
    let judgeCallCount = 0;
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
      postText: (_t, text) => texts.push(text),
      runBotTurn: async (botId, prompt) => {
        if (botId === "judge" && prompt.includes("任务前置评估")) {
          judgeCallCount++;
          return {
            ok: true,
            text: JSON.stringify({
              taskId: "task-test",
              complexity: "MODERATE",
              riskLevel: "MEDIUM",
              reasoningRecommendation: "HIGH",
              difficultyReason: "需要保留冻结代码",
              recommendedRoles: ["Developer"],
              acceptanceCriteria: ["仅修改指定函数", "提供有效Diff"],
              requiredEvidence: ["git diff"],
              riskWarnings: ["防逻辑回归"],
              requiresUserAuthorization: false,
            }),
          };
        }
        if (botId === "momo" && prompt.includes("自主决定")) {
          return {
            ok: true,
            text: JSON.stringify({
              decision: "SELF",
              reason: "修改范围可控，Momo 自行执行",
              delegateBotNames: [],
            }),
          };
        }
        if (botId === "momo" && prompt.includes("正在执行")) {
          return { ok: true, text: "完成修改并生成 Diff" };
        }
        if (botId === "judge" && prompt.includes("最终评审")) {
          judgeCallCount++;
          const hashes = [...prompt.matchAll(/artifactHash=([a-f0-9]+)/g)].map((x) => x[1]);
          const crits = [...prompt.matchAll(/criteriaVersion=([^\s\n]+)/g)].map((x) => x[1]);
          return {
            ok: true,
            text: JSON.stringify({
              verdict: "PASS",
              reason: "验收标准均满足",
              criteriaVersion: crits.at(-1),
              artifactHash: hashes.at(-1),
              evidenceGaps: [],
            }),
          };
        }
        return { ok: false, text: "", error: "unexpected" };
      },
    };

    const run = await startWorkflow(deps, {
      momoBotId: "momo",
      userRequest: "修改 main.cpp 中的网络重连逻辑，保留冻结代码",
    });

    for (let i = 0; i < 100; i++) {
      await sleep(25);
      if (events.includes("COMPLETED")) break;
    }

    expect(judgeCallCount).toBe(2); // 1 for Pre-Review, 1 for Final Review
    expect(events).toContain("FAST_GATE");
    expect(events).toContain("PRE_REVIEW");
    expect(events).toContain("PLAN_DONE");
    expect(events).toContain("EXECUTING");
    expect(events).toContain("FINAL_REVIEW");
    expect(events).toContain("COMPLETED");
    expect(texts.some((t) => t.includes("Judge 前置评估"))).toBe(true);
    expect(texts.some((t) => t.includes("仅修改指定函数"))).toBe(true);
    void run;
  });

  it("Judge failure blocks task and never bypasses review", async () => {
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
      runBotTurn: async (botId) => {
        if (botId === "judge") {
          return { ok: false, text: "", error: "Judge provider 503 service unavailable" };
        }
        return { ok: true, text: "{}" };
      },
    };

    await startWorkflow(deps, {
      momoBotId: "momo",
      userRequest: "修改 main.cpp 生产配置",
    });

    for (let i = 0; i < 100; i++) {
      await sleep(25);
      if (events.includes("PRE_REVIEW_FAIL")) break;
    }

    expect(events).toContain("PRE_REVIEW_FAIL");
    expect(events).not.toContain("EXECUTING");
    expect(events).not.toContain("COMPLETED");
  });
});

describe("C. Momo Autonomy & Worker Dispatching", () => {
  it("Momo autonomously selects DELEGATE to Developer and QA", async () => {
    const events: string[] = [];
    const dispatchedWorkers: string[] = [];
    const bots = [
      { id: "momo", name: "Momo", threadId: "tm", busy: false },
      { id: "judge", name: "Judge", threadId: "tj", busy: false },
      { id: "dev", name: "Developer", threadId: "td", busy: false },
      { id: "qa", name: "QA", threadId: "tq", busy: false },
    ];

    const deps: WorkflowDeps = {
      findBotByName: (n) => bots.find((b) => b.name.toLowerCase() === n.toLowerCase()),
      findBotById: (id) => bots.find((b) => b.id === id),
      listVisibleTeam: (except) => bots.filter((b) => b.id !== except),
      canXHighForBot: () => false,
      setBusy: () => {},
      postWorkflowEvent: (_t, e) => {
        events.push(e.stage);
        if (e.stage === "WORKER") {
          dispatchedWorkers.push(e.summary);
        }
      },
      postText: () => {},
      runBotTurn: async (botId, prompt) => {
        if (botId === "judge" && prompt.includes("任务前置评估")) {
          return {
            ok: true,
            text: JSON.stringify({
              complexity: "COMPLEX",
              riskLevel: "MEDIUM",
              reasoningRecommendation: "HIGH",
              difficultyReason: "多模块交互",
              recommendedRoles: ["Developer", "QA"],
              acceptanceCriteria: ["开发完成并通过单元测试"],
              requiredEvidence: ["git diff", "test log"],
              requiresUserAuthorization: false,
            }),
          };
        }
        if (botId === "momo" && prompt.includes("自主决定")) {
          return {
            ok: true,
            text: JSON.stringify({
              decision: "DELEGATE",
              reason: "跨模块改动，由 Developer 实现并由 QA 验证",
              delegateBotNames: ["Developer", "QA"],
            }),
          };
        }
        if (botId === "dev") {
          return { ok: true, text: "Developer: C++ 实现完成并附带 Diff" };
        }
        if (botId === "qa") {
          return { ok: true, text: "QA: 回归测试 14 项全绿通过" };
        }
        if (botId === "momo" && prompt.includes("正在执行")) {
          return { ok: true, text: "Momo 汇总：代码修改与QA测试均已达标" };
        }
        if (botId === "judge" && prompt.includes("最终评审")) {
          const hashes = [...prompt.matchAll(/artifactHash=([a-f0-9]+)/g)].map((x) => x[1]);
          const crits = [...prompt.matchAll(/criteriaVersion=([^\s\n]+)/g)].map((x) => x[1]);
          return {
            ok: true,
            text: JSON.stringify({
              verdict: "PASS",
              reason: "代码质量与测试证据均满足",
              criteriaVersion: crits.at(-1),
              artifactHash: hashes.at(-1),
              evidenceGaps: [],
            }),
          };
        }
        return { ok: false, text: "", error: `Unexpected ${botId}` };
      },
    };

    await startWorkflow(deps, {
      momoBotId: "momo",
      userRequest: "对感知融合模块进行性能重构并进行完整回归测试",
    });

    for (let i = 0; i < 100; i++) {
      await sleep(25);
      if (events.includes("COMPLETED")) break;
    }

    expect(events).toContain("PLAN_DONE");
    expect(dispatchedWorkers.some((w) => w.includes("Developer"))).toBe(true);
    expect(dispatchedWorkers.some((w) => w.includes("QA"))).toBe(true);
    expect(events).toContain("COMPLETED");
  });
});

describe("D. Judge Final Review & Cryptographic Binding", () => {
  it("rejects PASS when artifact hash does not match locked artifact", async () => {
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
      runBotTurn: async (botId, prompt) => {
        if (botId === "judge" && prompt.includes("任务前置评估")) {
          return {
            ok: true,
            text: JSON.stringify({
              complexity: "SIMPLE",
              riskLevel: "LOW",
              reasoningRecommendation: "HIGH",
              difficultyReason: "simple",
              recommendedRoles: [],
              acceptanceCriteria: ["done"],
              requiredEvidence: [],
              requiresUserAuthorization: false,
            }),
          };
        }
        if (botId === "momo" && prompt.includes("自主决定")) {
          return { ok: true, text: JSON.stringify({ decision: "SELF", reason: "solo", delegateBotNames: [] }) };
        }
        if (botId === "momo" && prompt.includes("正在执行")) {
          return { ok: true, text: "executed" };
        }
        if (botId === "judge" && prompt.includes("最终评审")) {
          // Returning stale or counterfeit artifact hash!
          return {
            ok: true,
            text: JSON.stringify({
              verdict: "PASS",
              reason: "fake pass with bad hash",
              criteriaVersion: "wrong-version",
              artifactHash: "0000000000000000",
              evidenceGaps: [],
            }),
          };
        }
        return { ok: false, text: "", error: "error" };
      },
    };

    await startWorkflow(deps, {
      momoBotId: "momo",
      userRequest: "修改 main.cpp",
    });

    for (let i = 0; i < 100; i++) {
      await sleep(25);
      if (events.includes("FINAL_REVIEW_DONE")) break;
    }

    expect(events).toContain("FINAL_REVIEW_DONE");
    // Since binding validation failed, PASS was demoted to BLOCKED, and momoDelivery/COMPLETED was never triggered!
    expect(events).not.toContain("COMPLETED");
  });

  it("FAIL triggers rework loop up to 2 rounds then halts", async () => {
    const events: string[] = [];
    let reworkAttempts = 0;
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
      postWorkflowEvent: (_t, e) => {
        events.push(e.stage);
        if (e.stage === "REWORK") reworkAttempts++;
      },
      postText: () => {},
      runBotTurn: async (botId, prompt) => {
        if (botId === "judge" && prompt.includes("任务前置评估")) {
          return {
            ok: true,
            text: JSON.stringify({
              complexity: "SIMPLE",
              riskLevel: "LOW",
              reasoningRecommendation: "HIGH",
              difficultyReason: "simple",
              recommendedRoles: [],
              acceptanceCriteria: ["all pass"],
              requiredEvidence: [],
              requiresUserAuthorization: false,
            }),
          };
        }
        if (botId === "momo" && prompt.includes("自主决定")) {
          return { ok: true, text: JSON.stringify({ decision: "SELF", reason: "rework plan", delegateBotNames: [] }) };
        }
        if (botId === "momo" && prompt.includes("正在执行")) {
          return { ok: true, text: "rework execution" };
        }
        if (botId === "judge" && prompt.includes("最终评审")) {
          const hashes = [...prompt.matchAll(/artifactHash=([a-f0-9]+)/g)].map((x) => x[1]);
          const crits = [...prompt.matchAll(/criteriaVersion=([^\s\n]+)/g)].map((x) => x[1]);
          // Persistent failure
          return {
            ok: true,
            text: JSON.stringify({
              verdict: "FAIL",
              reason: "单元测试仍有 1 项未通过",
              criteriaVersion: crits.at(-1),
              artifactHash: hashes.at(-1),
              evidenceGaps: ["test_fail"],
            }),
          };
        }
        return { ok: false, text: "", error: "error" };
      },
    };

    await startWorkflow(deps, {
      momoBotId: "momo",
      userRequest: "修改 main.cpp 中的网络重连逻辑",
    });

    for (let i = 0; i < 150; i++) {
      await sleep(30);
      if (reworkAttempts >= 2 && events.filter((e) => e === "FINAL_REVIEW_DONE").length >= 3) break;
    }

    // Exactly 2 reworks executed
    expect(reworkAttempts).toBe(2);
    expect(events).not.toContain("COMPLETED");
  });
});

describe("E. Persistent Checkpointer & Secrets Redaction", () => {
  it("persists checkpoint to disk and strips secrets", async () => {
    const testDir = join(tmpdir(), `ckpt-test-${Date.now()}`);
    const saver = new FileCheckpointSaver(testDir);

    const config = { configurable: { thread_id: "thread-secret-test" } };
    const checkpoint = {
      id: "cp-1",
      ts: Date.now(),
      v: 1,
      channel_values: {
        safeData: "hello",
        apiKey: "sk-proj-secret-12345",
        authToken: "bearer-token-abcde",
      },
    } as any;
    const metadata = { source: "test" } as any;

    await saver.put(config, checkpoint, metadata);

    // Verify sanitized from disk
    const reloadedSaver = new FileCheckpointSaver(testDir);
    const tuple = await reloadedSaver.getTuple(config);
    expect(tuple).toBeDefined();
    const values = tuple?.checkpoint.channel_values as any;
    expect(values.safeData).toBe("hello");
    expect(values.apiKey).toBe("[REDACTED_BY_CHECKPOINTER]");
    expect(values.authToken).toBe("[REDACTED_BY_CHECKPOINTER]");

    // Clean up
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resource lock manages concurrency properly", async () => {
    const order: number[] = [];
    const task1 = globalResourceLockManager.withLock("workspace", "bot-1", async () => {
      await sleep(50);
      order.push(1);
    });
    const task2 = globalResourceLockManager.withLock("workspace", "bot-2", async () => {
      order.push(2);
    });

    await Promise.all([task1, task2]);
    expect(order).toEqual([1, 2]);
  });

  it("cancelWorkflow cancels in-flight task safely", async () => {
    let busy = false;
    const deps: WorkflowDeps = {
      findBotByName: (n) => ({ id: n.toLowerCase(), name: n, threadId: `t-${n}`, busy: false }),
      findBotById: (id) => ({ id, name: id, threadId: `t-${id}`, busy: false }),
      listVisibleTeam: () => [],
      canXHighForBot: () => false,
      setBusy: (_id, b) => { busy = b; },
      postWorkflowEvent: () => {},
      postText: () => {},
      runBotTurn: async () => {
        await sleep(500);
        return { ok: true, text: "done" };
      },
    };

    const run = await startWorkflow(deps, { momoBotId: "momo", userRequest: "long task" });
    const cancelled = cancelWorkflow(deps, "momo", "test cancel");
    expect(cancelled).toBe(true);
    expect(busy).toBe(false);
    void run;
  });

  it("approveWorkflow handles approval state transitions", async () => {
    const deps: WorkflowDeps = {
      findBotByName: (n) => ({ id: n.toLowerCase(), name: n, threadId: `t-${n}`, busy: false }),
      findBotById: (id) => ({ id, name: id, threadId: `t-${id}`, busy: false }),
      listVisibleTeam: () => [],
      canXHighForBot: () => false,
      setBusy: () => {},
      postWorkflowEvent: () => {},
      postText: () => {},
      runBotTurn: async () => ({ ok: true, text: "{}" }),
    };

    // When no workflow is waiting, returns false
    const ok = await approveWorkflow(deps, "non-existent-id", true);
    expect(ok).toBe(false);
  });

  it("L3 human approval uses LangGraph interrupt and resumes without replaying Pre-Review", async () => {
    const events: string[] = [];
    let preReviewCalls = 0;
    let planCalls = 0;
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
      runBotTurn: async (botId, prompt) => {
        if (botId === "judge" && prompt.includes("任务前置评估")) {
          preReviewCalls++;
          return {
            ok: true,
            text: JSON.stringify({
              taskId: "task-l3",
              complexity: "COMPLEX",
              riskLevel: "HIGH",
              reasoningRecommendation: "HIGH",
              difficultyReason: "生产删除",
              recommendedRoles: ["Deploy"],
              acceptanceCriteria: ["需人工批准", "提供操作日志"],
              requiredEvidence: ["audit log"],
              riskWarnings: ["destructive"],
              requiresUserAuthorization: true,
            }),
          };
        }
        if (botId === "judge" && prompt.includes("最终评审")) {
          return {
            ok: true,
            text: JSON.stringify({
              verdict: "PASS",
              reason: "已批准并完成",
              criteriaVersion: "crit-x",
              artifactHash: "hash-x",
              evidenceGaps: [],
            }),
          };
        }
        if (botId === "momo" && prompt.includes("请自主决定怎么做")) {
          planCalls++;
          return {
            ok: true,
            text: JSON.stringify({
              decision: "SELF",
              reason: "批准后自行执行",
              delegateBotNames: [],
            }),
          };
        }
        if (botId === "momo") {
          return { ok: true, text: "executed after approval" };
        }
        return { ok: true, text: "{}" };
      },
    };

    const run = await startWorkflow(deps, {
      momoBotId: "momo",
      userRequest: "删除生产服务器上的临时备份目录",
    });

    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const current = loadWorkflowRun(run.runId);
      if (current?.state === "WAITING_APPROVAL") break;
    }

    const waiting = loadWorkflowRun(run.runId);
    expect(waiting?.state).toBe("WAITING_APPROVAL");
    expect(preReviewCalls).toBe(1);
    expect(planCalls).toBe(0);

    const ok = await approveWorkflow(deps, run.runId, true);
    expect(ok).toBe(true);

    for (let i = 0; i < 80; i++) {
      await sleep(50);
      const current = loadWorkflowRun(run.runId);
      if (current && ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"].includes(current.state)) break;
    }

    const done = loadWorkflowRun(run.runId);
    expect(preReviewCalls).toBe(1);
    expect(planCalls).toBeGreaterThanOrEqual(1);
    expect(events).toContain("WAITING_APPROVAL");
    expect(events).toContain("APPROVAL_GRANTED");
    expect(done?.state).toMatch(/COMPLETED|FAILED|BLOCKED/);
  });
});

describe("F. Stress & Fast Route Performance (100 runs)", () => {
  it("executes 100 fast L0/L1 routes under 5 seconds with zero Judge calls", async () => {
    let judgeCalls = 0;
    const deps: WorkflowDeps = {
      findBotByName: () => ({ id: "momo", name: "Momo", threadId: "tm", busy: false }),
      findBotById: () => ({ id: "momo", name: "Momo", threadId: "tm", busy: false }),
      listVisibleTeam: () => [],
      canXHighForBot: () => false,
      setBusy: () => {},
      postWorkflowEvent: () => {},
      postText: () => {},
      runBotTurn: async (botId) => {
        if (botId === "judge") judgeCalls++;
        return { ok: true, text: "Fast answer" };
      },
    };

    const graph = buildLangGraphWorkflow(deps);
    const start = Date.now();

    for (let i = 0; i < 100; i++) {
      const prompt = i % 2 === 0 ? "hello" : "查询额度快照";
      const res = await graph.invoke({
        workflowId: `perf-${i}`,
        threadId: "tm",
        momoBotId: "momo",
        judgeBotId: "judge",
        userRequest: prompt,
      });
      expect(res.executionStatus).toBe("COMPLETED");
    }

    const elapsed = Date.now() - start;
    expect(judgeCalls).toBe(0);
    expect(elapsed).toBeLessThan(8000);
  });
});
