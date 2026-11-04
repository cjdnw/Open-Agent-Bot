import { createHash } from "node:crypto";
import { interrupt } from "@langchain/langgraph";
import type {
  ExecutionRecord,
  WorkflowDeps,
} from "./types.ts";
import type { WorkflowGraphState } from "./state.ts";
import { evaluateFastGate } from "./fast-gate.ts";
import { globalResourceLockManager } from "./resource-lock.ts";
import {
  parseFinalReview,
  parseMomoPlan,
  parsePreReview,
  validateFinalBinding,
} from "../workflow.ts";
import {
  judgeFinalReviewPrompt,
  judgePreReviewPrompt,
  momoExecutePrompt,
  momoPlanPrompt,
  workerExecutePrompt,
} from "../workflow-prompts.ts";

export async function computeArtifactHash(parts: string[]): Promise<string> {
  return createHash("sha256").update(parts.join("\n---\n")).digest("hex").slice(0, 16);
}

function rosterLines(team: Array<{ name: string; title?: string }>): string {
  return team.map((b) => `- ${b.name}${b.title ? ` (${b.title})` : ""}`).join("\n") || "- (none)";
}

function isJudgeBot(name: string): boolean {
  return /^judge$/i.test(name.trim());
}

export function createWorkflowNodes(deps: WorkflowDeps) {
  return {
    // ── 1. Fast Gate ─────────────────────────────────────────────
    fastGateNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      const gate = evaluateFastGate(state.userRequest);
      const isL0 = gate.routeLevel === "L0";

      // Emit UI card for formal tasks (L1, L2, L3)
      if (!isL0) {
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "FAST_GATE",
          stage: "FAST_GATE",
          summary: `[Fast Gate] ${gate.routeLevel}：${gate.routeReason}`,
          detail: gate,
          ok: true,
        });
      }

      return {
        routeLevel: gate.routeLevel,
        routeReason: gate.routeReason,
        judgeRequired: gate.judgeRequired,
        complexity: gate.suggestedComplexity,
        riskLevel: gate.suggestedRiskLevel,
        history: [
          {
            state: "FAST_GATE",
            at: Date.now(),
            note: `${gate.routeLevel}: ${gate.routeReason}`,
          },
        ],
      };
    },

    // ── 2. Momo Fast Chat (L0) ───────────────────────────────────
    momoFastChatNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      const turn = await deps.runBotTurn(state.momoBotId, state.userRequest, {
        reasoningEffort: "high",
        label: "momo-fast-chat",
      });

      if (turn.ok && turn.text) {
        deps.postText(state.threadId, turn.text);
      }

      return {
        executionStatus: turn.ok ? "COMPLETED" : "FAILED",
        output: turn.text,
        history: [{ state: "FAST_CHAT_DONE", at: Date.now(), note: "L0 Fast Chat completed directly by Momo" }],
      };
    },

    // ── 3. Momo Light Task (L1) ──────────────────────────────────
    momoLightNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      const prompt = `用户请求了一个只读/查询类任务：\n${state.userRequest}\n\n请直接处理并给出简洁、完整的回答。注意：你处于轻量只读任务模式，不要自行进行代码写操作、文件破坏或远程部署；如果发现该任务必须修改文件、执行高风险脚本或交付正式工程物，请在回复开头明确声明 [NEED_UPGRADE]。`;
      const turn = await deps.runBotTurn(state.momoBotId, prompt, {
        reasoningEffort: "high",
        label: "momo-light-task",
      });

      const needsUpgrade = turn.text.includes("[NEED_UPGRADE]") || /(修改文件|写入磁盘|远程部署|生产服务)/i.test(turn.text);

      if (needsUpgrade) {
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "FAST_GATE",
          stage: "UPGRADE",
          summary: "L1 检测到写操作或正式交付需求，安全升级至 L2 正式评审工作流",
          ok: true,
        });
        return {
          upgradeRequired: true,
          routeLevel: "L2",
          judgeRequired: true,
          history: [{ state: "UPGRADED_TO_L2", at: Date.now(), note: "Upgraded from L1 to L2" }],
        };
      }

      if (turn.ok && turn.text) {
        deps.postText(state.threadId, turn.text);
      }

      return {
        upgradeRequired: false,
        executionStatus: turn.ok ? "COMPLETED" : "FAILED",
        output: turn.text,
        history: [{ state: "LIGHT_TASK_DONE", at: Date.now(), note: "L1 completed" }],
      };
    },

    // ── 4. Judge Pre-Review (L2 / L3) ────────────────────────────
    judgePreReviewNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "PRE_REVIEW",
        stage: "PRE_REVIEW",
        summary: "Judge 前置评估开始",
      });

      const team = deps.listVisibleTeam(state.momoBotId).filter((b) => !isJudgeBot(b.name));
      const canXHigh = deps.canXHighForBot(state.judgeBotId);
      const prePrompt = judgePreReviewPrompt({
        taskId: state.workflowId,
        userRequest: state.userRequest,
        teamRoster: rosterLines(team),
        canXHigh,
      });

      const preTurn = await deps.runBotTurn(state.judgeBotId, prePrompt, {
        reasoningEffort: canXHigh ? "xhigh" : "high",
        label: "judge-pre-review",
      });

      const pre = parsePreReview(preTurn.text, state.workflowId, canXHigh);
      if (!preTurn.ok || !pre) {
        const errorMsg = preTurn.error || "Judge 前置评估未返回可解析 JSON；任务进入 BLOCKED，严禁绕过验收";
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "BLOCKED",
          stage: "PRE_REVIEW_FAIL",
          summary: errorMsg,
          detail: { raw: preTurn.text.slice(0, 600) },
          ok: false,
        });
        deps.postText(state.threadId, `Judge 前置评估失败/不可用：${errorMsg}\n任务已被安全阻止（BLOCKED），不得继续执行。`);
        return {
          executionStatus: "BLOCKED",
          errors: [errorMsg],
          history: [{ state: "BLOCKED", at: Date.now(), note: errorMsg }],
        };
      }

      const lockedCriteriaVersion = `crit-${Date.now().toString(36)}`;
      const requiresAuth = pre.requiresUserAuthorization || state.routeLevel === "L3";

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "PRE_REVIEW",
        stage: "PRE_REVIEW_DONE",
        summary: `复杂度：${pre.complexity} · 风险：${pre.riskLevel} · 推理建议：${pre.reasoningRecommendation}`,
        detail: pre,
        ok: true,
      });

      deps.postText(
        state.threadId,
        [
          "### Judge 前置评估",
          `- 复杂度：${pre.complexity}`,
          `- 风险：${pre.riskLevel}`,
          `- 推理建议：${pre.reasoningRecommendation}（生效：${pre.reasoningEffective}）`,
          `- 需要用户授权：${requiresAuth ? "是" : "否"}`,
          `- 原因：${pre.difficultyReason}`,
          `- 建议角色：${pre.recommendedRoles.join(", ") || "无"}`,
          `- 验收标准：`,
          ...pre.acceptanceCriteria.map((c) => `  - ${c}`),
          `- 所需证据：`,
          ...(pre.requiredEvidence.length ? pre.requiredEvidence.map((c) => `  - ${c}`) : ["  - （无额外）"]),
          `- 风险警告：`,
          ...(pre.riskWarnings.length ? pre.riskWarnings.map((c) => `  - ${c}`) : ["  - （无）"]),
        ].join("\n"),
      );

      return {
        judgePreReview: pre,
        complexity: pre.complexity,
        riskLevel: pre.riskLevel,
        reasoningEffective: pre.reasoningEffective,
        acceptanceCriteria: pre.acceptanceCriteria,
        requiredEvidence: pre.requiredEvidence,
        requiresHumanApproval: requiresAuth,
        criteriaVersion: lockedCriteriaVersion,
        history: [{ state: "PRE_REVIEW_DONE", at: Date.now(), note: `Locked criteria version: ${lockedCriteriaVersion}` }],
      };
    },

    // ── 5. Human Approval Node (LangGraph interrupt / resume) ────
    humanApprovalNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "WAITING_APPROVAL",
        stage: "WAITING_APPROVAL",
        summary: "高风险/受保护操作需用户授权后方可继续",
        ok: false,
      });
      deps.postText(
        state.threadId,
        "⚠️ 本任务属于高风险操作（L3/HIGH RISK），需要人工授权批准。请核实后批准以继续。",
      );

      // Pause the StateGraph until approveWorkflow resumes with Command({ resume }).
      // Do not wrap interrupt() in try/catch — GraphInterrupt must propagate.
      // Note: LangGraph.js may surface this as invoke() returning `__interrupt__`
      // rather than throwing; the engine handles both shapes.
      const resumeValue = interrupt({
        kind: "human_approval",
        runId: state.workflowId,
        riskLevel: state.riskLevel,
        routeLevel: state.routeLevel,
      }) as boolean | { approved?: boolean };

      const approved =
        resumeValue === true ||
        (typeof resumeValue === "object" && resumeValue?.approved === true);

      if (!approved) {
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "CANCELLED",
          stage: "APPROVAL_REJECTED",
          summary: "用户拒绝授权高风险任务，流程终止",
          ok: false,
        });
        deps.postText(state.threadId, "高风险任务已被用户拒绝，流程已取消。");
        return {
          pendingApproval: false,
          approvalGranted: false,
          executionStatus: "CANCELLED",
          history: [{ state: "CANCELLED", at: Date.now(), note: "User rejected authorization" }],
        };
      }

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "PLANNING",
        stage: "APPROVAL_GRANTED",
        summary: "用户已批准高风险任务，继续执行",
        ok: true,
      });
      return {
        pendingApproval: false,
        approvalGranted: true,
        history: [{ state: "APPROVAL_GRANTED", at: Date.now() }],
      };
    },

    // ── 6. Momo Planner Node ─────────────────────────────────────
    momoPlannerNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "PLANNING",
        stage: "PLANNING",
        summary: "Momo 正在自主评估执行策略",
      });

      const team = deps.listVisibleTeam(state.momoBotId).filter((b) => !isJudgeBot(b.name));
      const planPrompt = momoPlanPrompt({
        userRequest: state.userRequest,
        preReview: state.judgePreReview!,
        teamRoster: rosterLines(team),
        reworkRound: state.reworkCount,
        priorFailReason: state.judgeFinalReview?.reason,
      });

      const planTurn = await deps.runBotTurn(state.momoBotId, planPrompt, {
        reasoningEffort: state.reasoningEffective === "XHIGH" ? "xhigh" : "high",
        label: "momo-plan",
      });

      let plan = parseMomoPlan(planTurn.text);
      if (!planTurn.ok || !plan) {
        if (state.complexity === "SIMPLE" && planTurn.ok) {
          plan = { decision: "SELF", reason: "解析回退：简单任务 Momo 自行完成", delegateBotNames: [], at: Date.now() };
        } else {
          const err = planTurn.error || "Momo 未返回可解析的执行决策 JSON";
          deps.postWorkflowEvent(state.threadId, {
            runId: state.workflowId,
            state: "FAILED",
            stage: "PLAN_FAIL",
            summary: err,
            ok: false,
          });
          return {
            executionStatus: "FAILED",
            errors: [err],
            history: [{ state: "PLAN_FAILED", at: Date.now(), note: err }],
          };
        }
      }

      // Safety: Cannot choose SELF to bypass human authorization requirement
      if (state.requiresHumanApproval && !state.approvalGranted && plan.decision !== "ESCALATE") {
        plan = {
          ...plan,
          decision: "ESCALATE",
          reason: `强制 ESCALATE：前置评估要求人工授权，当前未授权。原决策 ${plan.decision} 覆盖。`,
        };
      }

      // Guard against false claims like "协作流已关闭" when collaboration is actually on
      if (plan.decision === "SELF" && /协作流已关闭|只能自干/.test(plan.reason)) {
        plan = {
          ...plan,
          reason: `协作流已开启，Momo 确认独立执行该模块`,
        };
      }

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "PLANNING",
        stage: "PLAN_DONE",
        summary: `Momo 决策：${plan.decision}（${plan.decision === "SELF" ? "自行执行" : `委派 ${plan.delegateBotNames.join(", ")}`}）`,
        detail: plan,
        ok: true,
      });

      deps.postText(
        state.threadId,
        [
          "### Momo 执行决策",
          `- 决策：${plan.decision}`,
          `- 理由：${plan.reason}`,
          plan.decision === "DELEGATE" ? `- 委派员工：${plan.delegateBotNames.join(", ") || "按建议角色分配"}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return {
        momoDecision: plan,
        executionMode: plan.decision,
        selectedBots: plan.delegateBotNames,
        history: [{ state: "PLAN_DONE", at: Date.now(), note: `Decision: ${plan.decision}` }],
      };
    },

    // ── 7. Momo Solo Executor Node (SELF) ────────────────────────
    momoExecutorNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "EXECUTING",
        stage: "EXECUTING",
        summary: "Momo 自行执行任务",
      });

      const execPrompt = momoExecutePrompt({
        userRequest: state.userRequest,
        preReview: state.judgePreReview!,
        planReason: state.momoDecision?.reason || "Momo 自主选择独立执行",
        mode: "SELF",
      });

      const turn = await deps.runBotTurn(state.momoBotId, execPrompt, {
        reasoningEffort: state.reasoningEffective === "XHIGH" ? "xhigh" : "high",
        label: "momo-execute-solo",
      });

      if (!turn.ok) {
        const error = turn.error || "Momo 执行失败";
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "FAILED",
          stage: "EXEC_FAIL",
          summary: error,
          ok: false,
        });
        return {
          executionStatus: "FAILED",
          errors: [error],
          history: [{ state: "EXEC_FAILED", at: Date.now(), note: error }],
        };
      }

      const summary = turn.text;
      const evidence = [turn.text];
      const artifactHash = await computeArtifactHash([
        state.criteriaVersion,
        state.userRequest,
        ...state.acceptanceCriteria,
        summary,
        ...evidence,
        String(state.reworkCount),
      ]);

      const record: ExecutionRecord = {
        actor: "momo",
        summary,
        evidence,
        artifactHash,
        reworkRound: state.reworkCount,
        at: Date.now(),
      };

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "EXECUTING",
        stage: "EXEC_DONE",
        summary: `执行产物哈希：${artifactHash}`,
        detail: record,
        ok: true,
      });

      return {
        executionRecord: record,
        executionSummary: summary,
        artifactHash,
        evidenceReferences: evidence,
        history: [{ state: "EXEC_DONE", at: Date.now(), note: `Artifact: ${artifactHash}` }],
      };
    },

    // ── 8. Worker Dispatcher Node (DELEGATE) ─────────────────────
    workerDispatcherNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "EXECUTING",
        stage: "DISPATCHING",
        summary: "委派专业员工团队执行",
      });

      const team = deps.listVisibleTeam(state.momoBotId).filter((b) => !isJudgeBot(b.name));
      const requestedNames =
        state.selectedBots && state.selectedBots.length > 0
          ? state.selectedBots
          : state.judgePreReview?.recommendedRoles || [];

      // Match worker bots
      const workers = requestedNames
        .map((name) => {
          const lower = name.toLowerCase().trim();
          return team.find(
            (b) =>
              b.name.toLowerCase() === lower ||
              (b.title || "").toLowerCase().includes(lower) ||
              lower.includes(b.name.toLowerCase()),
          );
        })
        .filter((b): b is NonNullable<typeof b> => Boolean(b));

      const parts: string[] = [];
      const evidence: string[] = [];

      if (workers.length === 0) {
        // Fallback: If no workers found, Momo completes the work alone
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "EXECUTING",
          stage: "FALLBACK_TO_MOMO",
          summary: "未找到匹配员工，改由 Momo 自行执行",
        });

        const turn = await deps.runBotTurn(
          state.momoBotId,
          momoExecutePrompt({
            userRequest: state.userRequest,
            preReview: state.judgePreReview!,
            planReason: "未匹配到指定员工，Momo 接管独立执行",
            mode: "SELF",
          }),
          { label: "momo-execute-lead" },
        );

        if (!turn.ok) {
          return {
            executionStatus: "FAILED",
            errors: [turn.error || "Momo 接管执行失败"],
          };
        }

        parts.push(turn.text);
        evidence.push(turn.text);
      } else {
        // Dispatch each worker with resource lock coordination
        for (const worker of workers) {
          deps.postWorkflowEvent(state.threadId, {
            runId: state.workflowId,
            state: "EXECUTING",
            stage: "WORKER",
            summary: `委派员工：${worker.name}`,
          });

          const workerTurn = await globalResourceLockManager.withLock(
            "workspace-write",
            worker.id,
            async () => {
              return await deps.runBotTurn(
                worker.id,
                workerExecutePrompt({
                  userRequest: state.userRequest,
                  preReview: state.judgePreReview!,
                  workerName: worker.name,
                }),
                { label: `worker-${worker.name}` },
              );
            },
          );

          parts.push(`#### ${worker.name}\n${workerTurn.text}`);
          evidence.push(`${worker.name}: ${workerTurn.text}`);

          deps.postWorkflowEvent(state.threadId, {
            runId: state.workflowId,
            state: "EXECUTING",
            stage: "WORKER_DONE",
            summary: `${worker.name} 执行完成`,
            ok: workerTurn.ok,
          });
        }
      }

      // Momo synthesizes worker outputs
      const synthesisTurn = await deps.runBotTurn(
        state.momoBotId,
        momoExecutePrompt({
          userRequest: state.userRequest,
          preReview: state.judgePreReview!,
          planReason: `各专业员工输出如下：\n\n${parts.join("\n\n")}`,
          mode: "DELEGATE_LEAD",
        }),
        { label: "momo-synthesize" },
      );

      const summary = synthesisTurn.text;
      evidence.push(synthesisTurn.text);

      const artifactHash = await computeArtifactHash([
        state.criteriaVersion,
        state.userRequest,
        ...state.acceptanceCriteria,
        summary,
        ...evidence,
        String(state.reworkCount),
      ]);

      const record: ExecutionRecord = {
        actor: workers.length > 0 ? "workers" : "momo",
        summary,
        evidence,
        artifactHash,
        reworkRound: state.reworkCount,
        at: Date.now(),
      };

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "EXECUTING",
        stage: "EXEC_DONE",
        summary: `多员工汇总产物哈希：${artifactHash}`,
        detail: record,
        ok: true,
      });

      return {
        executionRecord: record,
        executionSummary: summary,
        artifactHash,
        evidenceReferences: evidence,
        history: [{ state: "WORKERS_EXEC_DONE", at: Date.now(), note: `Artifact: ${artifactHash}` }],
      };
    },

    // ── 9. Judge Final Review Node ───────────────────────────────
    judgeFinalReviewNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "FINAL_REVIEW",
        stage: "FINAL_REVIEW",
        summary: "Judge 最终独立评审开始",
      });

      const canXHigh = deps.canXHighForBot(state.judgeBotId);
      const finalPrompt = judgeFinalReviewPrompt({
        userRequest: state.userRequest,
        preReview: state.judgePreReview!,
        criteriaVersion: state.criteriaVersion,
        artifactHash: state.artifactHash,
        execution: state.executionRecord!,
      });

      const finalTurn = await deps.runBotTurn(state.judgeBotId, finalPrompt, {
        reasoningEffort: canXHigh ? "xhigh" : "high",
        label: "judge-final-review",
      });

      let review = parseFinalReview(finalTurn.text, state.criteriaVersion, state.artifactHash);
      if (!finalTurn.ok || !review) {
        const errorMsg = finalTurn.error || "Judge 最终评审不可用或未返回可解析结论；严禁自动放行，进入 BLOCKED";
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "BLOCKED",
          stage: "FINAL_REVIEW_BLOCKED",
          summary: errorMsg,
          detail: { raw: finalTurn.text.slice(0, 600) },
          ok: false,
        });
        deps.postText(state.threadId, `Judge 最终评审 BLOCKED：${errorMsg}`);
        return {
          judgeFinalVerdict: "BLOCKED",
          executionStatus: "BLOCKED",
          errors: [errorMsg],
          history: [{ state: "FINAL_REVIEW_BLOCKED", at: Date.now(), note: errorMsg }],
        };
      }

      // Cryptographic binding validation: must match exact criteriaVersion & artifactHash
      review = validateFinalBinding(review, state.criteriaVersion, state.artifactHash);

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "FINAL_REVIEW",
        stage: "FINAL_REVIEW_DONE",
        summary: `Judge 最终裁决：${review.verdict}（${review.reason}）`,
        detail: review,
        ok: review.verdict === "PASS",
      });

      deps.postText(
        state.threadId,
        [
          "### Judge 最终评审",
          `- 裁决结论：${review.verdict}`,
          `- 裁决理由：${review.reason}`,
          `- criteriaVersion：${review.criteriaVersion}`,
          `- artifactHash：${review.artifactHash}`,
          review.evidenceGaps.length ? `- 证据缺口：${review.evidenceGaps.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return {
        judgeFinalVerdict: review.verdict,
        judgeFinalReview: review,
        history: [{ state: "FINAL_REVIEW_DONE", at: Date.now(), note: `Verdict: ${review.verdict}` }],
      };
    },

    // ── 10. Rework Node (FAIL) ───────────────────────────────────
    reworkNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      const nextRework = state.reworkCount + 1;
      const note = `Judge FAIL 进入返工 #${nextRework}：${state.judgeFinalReview?.reason || "缺陷待修复"}`;

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "REWORK",
        stage: "REWORK",
        summary: note,
        ok: false,
      });

      deps.postText(
        state.threadId,
        `### 返工 #${nextRework}\nJudge 裁决 FAIL：${state.judgeFinalReview?.reason}\nMomo 将重新制定执行策略并返工修复。`,
      );

      return {
        reworkCount: nextRework,
        history: [{ state: "REWORK", at: Date.now(), note }],
      };
    },

    // ── 11. Momo Delivery Node (PASS) ────────────────────────────
    momoDeliveryNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "COMPLETED",
        stage: "COMPLETED",
        summary: "Judge 已确认 PASS，Momo 正式交付成果",
        ok: true,
      });

      deps.postText(
        state.threadId,
        [
          "### Momo 交付",
          "Judge 独立评审已通过（PASS）。本任务标记为已验收完成。",
          state.executionSummary ? `\n${state.executionSummary}` : "",
        ].join("\n"),
      );

      return {
        executionStatus: "COMPLETED",
        output: state.executionSummary,
        history: [{ state: "COMPLETED", at: Date.now(), note: "Delivered with Judge PASS" }],
      };
    },
  };
}
