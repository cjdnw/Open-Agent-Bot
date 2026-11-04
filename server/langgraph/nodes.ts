import { createHash } from "node:crypto";
import { interrupt } from "@langchain/langgraph";
import type {
  ExecutionRecord,
  WorkflowDeps,
} from "./types.ts";
import type { WorkflowGraphState } from "./state.ts";
import { runAiGate } from "./gate/ai-gate.ts";
import { isGateBotName, resolveGateModelId } from "./gate/ensure-gate-bot.ts";
import { detectUpgradeIntentFromText, evaluateGateOperation } from "./gate/permissions.ts";
import { globalResourceLockManager } from "./resource-lock.ts";
import {
  formatRegistryForPrompt,
  lookupWorkersForTask,
} from "./worker-registry.ts";
import {
  momoPlanToRoutingDecision,
  routingGuardToMomoPlan,
  validateMomoRouting,
} from "./routing-guard.ts";
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

function isInfraBot(name: string): boolean {
  return isJudgeBot(name) || isGateBotName(name);
}

/** Deterministic dependency order; cycle already rejected by RoutingGuard. */
function topologicalAssignments(
  assignments: Array<{ role: string; objective: string; dependsOn?: string[] }>,
): Array<{ role: string; objective: string; dependsOn?: string[] }> {
  const byRole = new Map(assignments.map((a) => [a.role, a]));
  const result: typeof assignments = [];
  const seen = new Set<string>();
  const visit = (role: string) => {
    if (seen.has(role)) return;
    seen.add(role);
    const node = byRole.get(role);
    if (!node) return;
    for (const dep of node.dependsOn || []) visit(dep);
    result.push(node);
  };
  for (const a of assignments) visit(a.role);
  return result;
}

export function createWorkflowNodes(deps: WorkflowDeps) {
  return {
    // ── 1. Gate bot (Flash Low) → Rule Fallback ──────────────────
    fastGateNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      const taskId = state.workflowId || `gate-${Date.now().toString(36)}`;
      const gateBot = deps.findBotByName("Gate");
      const modelId = resolveGateModelId(
        gateBot ? [{ name: gateBot.name, modelSelection: gateBot.modelSelection }] : [],
      );

      const runGate = deps.runAiGate || runAiGate;
      if (gateBot) deps.setBusy(gateBot.id, true);
      let gate;
      try {
        gate = await runGate(
          { taskId, userRequest: state.userRequest },
          {
            classifyWithGemini: async (req, history, opts) => {
              const { classifyWithGeminiFlash } = await import("./gate/gemini-classifier.ts");
              return classifyWithGeminiFlash(req, history, { ...opts, modelId });
            },
          },
        );
      } finally {
        if (gateBot) deps.setBusy(gateBot.id, false);
      }

      const isL0 = gate.routeLevel === "L0";
      const source = gate.audit.classifierSource;
      const summary = `[Gate Bot/${source}] ${gate.routeLevel}：${gate.routeReason}`;

      // Always mirror onto Gate bot transcript so it shows as a real Bot.
      if (gateBot?.threadId) {
        deps.postText(
          gateBot.threadId,
          [
            `### Gate 分类`,
            `- routeLevel：${gate.routeLevel}`,
            `- source：${source}`,
            `- model：${gate.audit.modelId || modelId}`,
            `- reason：${gate.routeReason}`,
            gate.audit.fallbackReason ? `- fallbackReason：${gate.audit.fallbackReason}` : "",
            `- elapsedMs：${gate.audit.elapsedMs}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
        deps.postWorkflowEvent(gateBot.threadId, {
          runId: state.workflowId,
          state: "FAST_GATE",
          stage: "AI_GATE",
          summary,
          detail: gate.audit,
          ok: source === "GEMINI",
        });
      }

      if (!isL0) {
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "FAST_GATE",
          stage: "AI_GATE",
          summary,
          detail: {
            ...gate.audit,
            taskType: gate.taskType,
            requiresWrite: gate.requiresWrite,
            requiresFormalReview: gate.requiresFormalReview,
            gateBotId: gateBot?.id,
          },
          ok: true,
        });
      }

      return {
        routeLevel: gate.routeLevel,
        routeReason: gate.routeReason,
        judgeRequired: gate.judgeRequired,
        complexity: gate.suggestedComplexity,
        riskLevel: gate.suggestedRiskLevel,
        requiresHumanApproval: gate.requiresHumanApproval || gate.routeLevel === "L3",
        requiresWrite: gate.requiresWrite,
        gateAudit: gate.audit,
        history: [
          {
            state: "AI_GATE",
            at: Date.now(),
            note: `${gate.routeLevel}/${source}: ${gate.routeReason}`,
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

      const intentOp = detectUpgradeIntentFromText(turn.text) || detectUpgradeIntentFromText(state.userRequest);
      const perm = intentOp
        ? evaluateGateOperation(state.routeLevel || "L1", intentOp)
        : { allowed: true, reason: "no upgrade intent" };
      const needsUpgrade =
        turn.text.includes("[NEED_UPGRADE]") ||
        !perm.allowed ||
        /(修改文件|写入磁盘|远程部署|生产服务)/i.test(turn.text);

      if (needsUpgrade) {
        const upgradeTo = perm.upgradeTo || "L2";
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "FAST_GATE",
          stage: "UPGRADE",
          summary: `L1 检测到写/外部操作，升级至 ${upgradeTo}（${perm.reason}）`,
          ok: true,
        });
        return {
          upgradeRequired: true,
          routeLevel: upgradeTo,
          judgeRequired: true,
          requiresHumanApproval: upgradeTo === "L3",
          history: [{ state: `UPGRADED_TO_${upgradeTo}`, at: Date.now(), note: perm.reason }],
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

      const team = deps.listVisibleTeam(state.momoBotId).filter((b) => !isInfraBot(b.name));
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
          ...(pre.roleReasons
            ? Object.entries(pre.roleReasons).map(([role, reason]) => `  - ${role}：${reason}`)
            : []),
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

    // ── 4b. WorkerRegistry lookup (after Judge, before Momo) ─────
    workerRegistryLookupNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      const team = deps
        .listVisibleTeam(state.momoBotId)
        .filter((b) => !isInfraBot(b.name))
        .map((b) => ({
          id: b.id,
          name: b.name,
          title: b.title,
          busy: b.busy,
        }));

      const lookup = lookupWorkersForTask(
        team,
        state.userRequest,
        state.judgePreReview?.recommendedRoles || [],
        state.riskLevel,
      );

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "PLANNING",
        stage: "WORKER_REGISTRY",
        summary: `WorkerRegistry：${lookup.workers.length} 名员工；Judge 推荐 ${state.judgePreReview?.recommendedRoles.join(", ") || "无"}`,
        detail: {
          workers: lookup.workers.map((w) => ({
            role: w.role,
            botId: w.botId,
            availability: w.availability,
          })),
          matchReasons: lookup.matchReasons.slice(0, 8),
        },
        ok: true,
      });

      return {
        workerRegistry: lookup,
        workerCapabilities: lookup.workers,
        history: [
          {
            state: "WORKER_REGISTRY",
            at: Date.now(),
            note: `workers=${lookup.workers.length}`,
          },
        ],
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
      const isRetry = state.routingRetryCount > 0;
      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state: "PLANNING",
        stage: isRetry ? "MOMO_RETRY" : "PLANNING",
        summary: isRetry
          ? `Momo 修正决策（${state.routingRetryCount}/1）`
          : "Momo 正在自主评估执行策略",
      });

      const team = deps.listVisibleTeam(state.momoBotId).filter((b) => !isInfraBot(b.name));
      const registryText = state.workerRegistry
        ? formatRegistryForPrompt(state.workerRegistry)
        : rosterLines(team);

      const planPrompt = momoPlanPrompt({
        userRequest: state.userRequest,
        preReview: state.judgePreReview!,
        teamRoster: rosterLines(team),
        reworkRound: state.reworkCount,
        priorFailReason: state.judgeFinalReview?.reason,
        workerRegistryText: registryText,
        correctionHint: state.routingCorrectionHint || undefined,
      });

      const planTurn = await deps.runBotTurn(state.momoBotId, planPrompt, {
        reasoningEffort: state.reasoningEffective === "XHIGH" ? "xhigh" : "high",
        label: isRetry ? "momo-plan-retry" : "momo-plan",
      });

      let plan = planTurn.ok ? parseMomoPlan(planTurn.text) : null;

      // Soft-normalize false solo excuses; RoutingGuard still owns validity.
      if (plan?.decision === "SELF" && /协作流已关闭|只能自干/.test(plan.reason)) {
        plan = {
          ...plan,
          reason: "协作流已开启，Momo 确认独立执行该模块",
        };
      }

      if (!plan) {
        deps.postWorkflowEvent(state.threadId, {
          runId: state.workflowId,
          state: "PLANNING",
          stage: "PLAN_INVALID",
          summary: "INVALID：未返回有效 executionMode / 决策 JSON",
          detail: { raw: planTurn.text.slice(0, 600), error: planTurn.error },
          ok: false,
        });
        deps.postText(
          state.threadId,
          "### Momo Decision\nINVALID：未返回有效结构化决策（交由 RoutingGuard 处理）",
        );
        return {
          momoDecision: null,
          history: [{ state: "PLAN_INVALID", at: Date.now(), note: planTurn.error || "unparseable" }],
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
          "### Momo Decision",
          `- executionMode：${plan.decision}`,
          `- 理由：${plan.reason}`,
          plan.decision === "DELEGATE"
            ? `- selectedRoles：${plan.delegateBotNames.join(", ") || "（空）"}`
            : "",
          state.judgePreReview?.recommendedRoles?.length
            ? `- Judge 推荐：${state.judgePreReview.recommendedRoles.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return {
        momoDecision: plan,
        history: [{ state: "PLAN_DONE", at: Date.now(), note: `Decision: ${plan.decision}` }],
      };
    },

    // ── 6b. RoutingGuard — validate / retry / deterministic fallback ─
    routingGuardNode: async (state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> => {
      const registry = state.workerRegistry || {
        workers: state.workerCapabilities || [],
        matchReasons: [],
        at: Date.now(),
      };

      const decision = momoPlanToRoutingDecision(state.momoDecision);
      const result = validateMomoRouting({
        decision,
        preReview: state.judgePreReview!,
        registry,
        userRequest: state.userRequest,
        approvalGranted: state.approvalGranted,
        retryCount: state.routingRetryCount,
      });

      deps.postWorkflowEvent(state.threadId, {
        runId: state.workflowId,
        state:
          result.status === "BLOCKED"
            ? "BLOCKED"
            : result.status === "ESCALATE"
              ? "WAITING_APPROVAL"
              : "PLANNING",
        stage: "ROUTING_GUARD",
        summary: `RoutingGuard ${result.status}${result.fallbackApplied ? "（兜底）" : ""}：${result.reason}`,
        detail: result,
        ok: result.status === "VALID" || result.status === "FALLBACK",
      });

      if (result.retryRequested) {
        deps.postText(
          state.threadId,
          `### RoutingGuard\nINVALID / RETRY（${state.routingRetryCount + 1}/1）\n原因：${result.reason}`,
        );
        return {
          routingGuardResult: result,
          routingRetryCount: state.routingRetryCount + 1,
          routingCorrectionHint: result.reason,
          history: [{ state: "ROUTING_RETRY", at: Date.now(), note: result.reason }],
        };
      }

      if (result.status === "BLOCKED" || result.status === "INVALID") {
        deps.postText(state.threadId, `### RoutingGuard\nBLOCKED\n${result.reason}`);
        return {
          routingGuardResult: result,
          executionStatus: "BLOCKED",
          routingSource: result.routingSource,
          errors: [result.reason],
          history: [{ state: "BLOCKED", at: Date.now(), note: result.reason }],
        };
      }

      if (result.status === "ESCALATE") {
        deps.postText(state.threadId, `### RoutingGuard\nESCALATE\n${result.reason}`);
        return {
          routingGuardResult: result,
          executionMode: "ESCALATE",
          requiresHumanApproval: true,
          pendingApproval: true,
          routingSource: result.routingSource,
          history: [{ state: "ROUTING_ESCALATE", at: Date.now(), note: result.reason }],
        };
      }

      const plan = routingGuardToMomoPlan(result);
      const executorLabel =
        result.executionMode === "SELF"
          ? "Momo"
          : result.resolvedWorkers.map((w) => w.name).join(", ") || result.selectedRoles.join(", ");

      deps.postText(
        state.threadId,
        [
          "### RoutingGuard",
          `- 状态：${result.status}`,
          `- routingSource：${result.routingSource}`,
          `- fallbackApplied：${result.fallbackApplied ? "true" : "false"}`,
          `- executionMode：${result.executionMode}`,
          result.selectedRoles.length ? `- selectedRoles：${result.selectedRoles.join(", ")}` : "",
          `- Executor：${executorLabel}`,
          `- 原因：${result.reason}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return {
        routingGuardResult: result,
        momoDecision: plan,
        executionMode: result.executionMode || "SELF",
        selectedBots: result.selectedRoles,
        taskAssignments: result.taskAssignments,
        routingSource: result.routingSource,
        routingCorrectionHint: "",
        history: [
          {
            state: "ROUTING_GUARD",
            at: Date.now(),
            note: `${result.status}/${result.routingSource}/${result.executionMode}`,
          },
        ],
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

      const team = deps.listVisibleTeam(state.momoBotId).filter((b) => !isInfraBot(b.name));
      const assignments =
        state.taskAssignments && state.taskAssignments.length > 0
          ? topologicalAssignments(state.taskAssignments)
          : (state.selectedBots || []).map((role) => ({ role, objective: state.userRequest }));

      const requestedNames =
        assignments.length > 0
          ? assignments.map((a) => a.role)
          : state.selectedBots && state.selectedBots.length > 0
            ? state.selectedBots
            : state.judgePreReview?.recommendedRoles || [];

      // Prefer RoutingGuard-resolved botIds when present
      const resolvedIds = new Map(
        (state.routingGuardResult?.resolvedWorkers || []).map((w) => [w.role.toLowerCase(), w.botId]),
      );

      const workers = requestedNames
        .map((name) => {
          const roleKey = name.toLowerCase().trim();
          const resolvedId = resolvedIds.get(roleKey);
          if (resolvedId) {
            const byId = team.find((b) => b.id === resolvedId);
            if (byId) return byId;
          }
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
        routingRetryCount: 0,
        routingCorrectionHint: "",
        routingGuardResult: null,
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
