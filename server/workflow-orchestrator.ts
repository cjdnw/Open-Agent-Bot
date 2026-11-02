import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import {
  hashArtifact,
  MAX_AUTO_REWORK,
  newWorkflowIds,
  parseFinalReview,
  parseMomoPlan,
  parsePreReview,
  transition,
  validateFinalBinding,
  type ExecutionRecord,
  type WorkflowRun,
  type WorkflowState,
} from "./workflow.ts";
import {
  judgeFinalReviewPrompt,
  judgePreReviewPrompt,
  momoExecutePrompt,
  momoPlanPrompt,
  workerExecutePrompt,
} from "./workflow-prompts.ts";

export type WorkflowEventPayload = {
  runId: string;
  state: WorkflowState;
  stage: string;
  summary: string;
  detail?: unknown;
  ok?: boolean;
};

export interface WorkflowDeps {
  findBotByName: (name: string) => { id: string; name: string; title?: string; busy?: boolean } | undefined;
  findBotById: (id: string) => { id: string; name: string; title?: string; threadId: string; busy?: boolean } | undefined;
  listVisibleTeam: (exceptId: string) => Array<{ id: string; name: string; title?: string; busy?: boolean }>;
  /** Run a bot turn and return final assistant text. Must clear busy on the bot. */
  runBotTurn: (
    botId: string,
    prompt: string,
    opts?: { reasoningEffort?: "high" | "xhigh"; label?: string },
  ) => Promise<{ ok: boolean; text: string; error?: string }>;
  canXHighForBot: (botId: string) => boolean;
  postWorkflowEvent: (momoThreadId: string, event: WorkflowEventPayload) => void;
  postText: (momoThreadId: string, text: string) => void;
  setBusy: (botId: string, busy: boolean) => void;
  persistRun?: (run: WorkflowRun) => void;
}

const RUNS_DIR = join(DATA_DIR, "workflow-runs");
const activeByMomo = new Map<string, string>(); // momoBotId → runId
const runs = new Map<string, WorkflowRun>();

function persist(run: WorkflowRun) {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(join(RUNS_DIR, `${run.runId}.json`), JSON.stringify(run, null, 2), "utf8");
}

export function loadWorkflowRun(runId: string): WorkflowRun | undefined {
  if (runs.has(runId)) return runs.get(runId);
  const path = join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const run = JSON.parse(readFileSync(path, "utf8")) as WorkflowRun;
    runs.set(runId, run);
    return run;
  } catch {
    return undefined;
  }
}

export function getActiveWorkflowForMomo(momoBotId: string): WorkflowRun | undefined {
  const id = activeByMomo.get(momoBotId);
  return id ? loadWorkflowRun(id) : undefined;
}

export function isJudgeBotName(name: string): boolean {
  return /^judge$/i.test(name.trim());
}

/** Block Momo from ask_bot'ing Judge while a workflow owns the chat. */
export function workflowBlocksAskBot(momoBotId: string, targetBotName: string): string | null {
  const run = getActiveWorkflowForMomo(momoBotId);
  if (!run) return null;
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) return null;
  if (isJudgeBotName(targetBotName)) {
    return "workflow scheduler owns Judge stages — Momo must not ask_bot Judge or simulate review";
  }
  return null;
}

function rosterLines(team: Array<{ name: string; title?: string }>): string {
  return team.map((b) => `- ${b.name}${b.title ? ` (${b.title})` : ""}`).join("\n") || "- (none)";
}

function stageToken(run: WorkflowRun, state: WorkflowState): string {
  return `${run.runId}:${state}:${run.reworkCount}`;
}

function emit(deps: WorkflowDeps, run: WorkflowRun, stage: string, summary: string, detail?: unknown, ok?: boolean) {
  deps.postWorkflowEvent(run.momoThreadId, {
    runId: run.runId,
    state: run.state,
    stage,
    summary,
    detail,
    ok,
  });
}

function save(deps: WorkflowDeps, run: WorkflowRun) {
  runs.set(run.runId, run);
  persist(run);
  deps.persistRun?.(run);
}

export async function startWorkflow(
  deps: WorkflowDeps,
  input: { momoBotId: string; userRequest: string; judgeName?: string },
): Promise<WorkflowRun> {
  const momo = deps.findBotById(input.momoBotId);
  if (!momo) throw Object.assign(new Error("momo bot missing"), { status: 404 });
  if (getActiveWorkflowForMomo(momo.id)) {
    throw Object.assign(new Error("a workflow is already running for Momo — interrupt it first"), { status: 409 });
  }
  const judge = deps.findBotByName(input.judgeName || "Judge");
  if (!judge) throw Object.assign(new Error("Judge bot not found"), { status: 409 });

  const ids = newWorkflowIds();
  let run: WorkflowRun = {
    runId: ids.runId,
    taskId: ids.taskId,
    momoBotId: momo.id,
    momoThreadId: momo.threadId,
    judgeBotId: judge.id,
    userRequest: input.userRequest,
    criteriaVersion: ids.criteriaVersion,
    state: "CREATED",
    reworkCount: 0,
    history: [{ state: "CREATED", at: Date.now() }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stageTokens: {},
  };
  activeByMomo.set(momo.id, run.runId);
  save(deps, run);
  deps.setBusy(momo.id, true);

  void (async () => {
    try {
      await runPipeline(deps, run.runId);
    } catch (error) {
      const latest = loadWorkflowRun(run.runId);
      if (!latest) return;
      const failed = {
        ...latest,
        state: "FAILED" as const,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
        history: [...latest.history, { state: "FAILED" as const, at: Date.now(), note: String(error) }],
      };
      save(deps, failed);
      emit(deps, failed, "FAILED", failed.error || "workflow failed", undefined, false);
      deps.postText(
        failed.momoThreadId,
        `Workflow 失败：${failed.error}\n状态已保留，未经 Judge PASS 不算已验收交付。`,
      );
    } finally {
      activeByMomo.delete(momo.id);
      deps.setBusy(momo.id, false);
    }
  })();

  return run;
}

export function cancelWorkflow(deps: WorkflowDeps, momoBotId: string, reason = "cancelled by user"): boolean {
  const run = getActiveWorkflowForMomo(momoBotId);
  if (!run) return false;
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) return false;
  const next = { ...run, state: "CANCELLED" as const, error: reason, updatedAt: Date.now() };
  next.history = [...run.history, { state: "CANCELLED", at: Date.now(), note: reason }];
  save(deps, next);
  activeByMomo.delete(momoBotId);
  deps.setBusy(momoBotId, false);
  emit(deps, next, "CANCELLED", reason, undefined, false);
  return true;
}

async function runPipeline(deps: WorkflowDeps, runId: string): Promise<void> {
  let run = loadWorkflowRun(runId);
  if (!run) return;

  // ── PRE_REVIEW ──────────────────────────────────────────────
  run = transition(run, "PRE_REVIEW", "judge pre-review");
  run.stageTokens.PRE_REVIEW = stageToken(run, "PRE_REVIEW");
  save(deps, run);
  emit(deps, run, "PRE_REVIEW", "Judge 前置评估开始");

  const team = deps.listVisibleTeam(run.momoBotId).filter((b) => !isJudgeBotName(b.name));
  const canXHigh = deps.canXHighForBot(run.judgeBotId);
  const prePrompt = judgePreReviewPrompt({
    taskId: run.taskId,
    userRequest: run.userRequest,
    teamRoster: rosterLines(team),
    canXHigh,
  });
  const preTurn = await deps.runBotTurn(run.judgeBotId, prePrompt, {
    reasoningEffort: canXHigh ? "xhigh" : "high",
    label: "judge-pre-review",
  });
  run = loadWorkflowRun(runId)!;
  if (run.state === "CANCELLED") return;

  const pre = parsePreReview(preTurn.text, run.taskId, canXHigh);
  if (!preTurn.ok || !pre) {
    run = transition(run, "BLOCKED", "pre-review parse/fail");
    run.error = preTurn.error || "Judge 前置评估未返回可解析 JSON";
    save(deps, run);
    emit(deps, run, "BLOCKED", run.error, { raw: preTurn.text.slice(0, 800) }, false);
    deps.postText(run.momoThreadId, `Judge 前置评估失败/不可用：${run.error}\n任务保留为 BLOCKED，不得继续执行。`);
    return;
  }
  run.preReview = pre;
  save(deps, run);
  emit(deps, run, "PRE_REVIEW_DONE", `复杂度 ${pre.complexity} · 风险 ${pre.riskLevel}`, pre, true);
  deps.postText(
    run.momoThreadId,
    [
      "### Judge 前置评估",
      `- 复杂度：${pre.complexity}`,
      `- 风险：${pre.riskLevel}`,
      `- 推理建议：${pre.reasoningRecommendation}（生效：${pre.reasoningEffective}）`,
      `- 需要用户授权：${pre.requiresUserAuthorization ? "是" : "否"}`,
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

  // planning / execute / review loop (includes rework)
  for (;;) {
    run = loadWorkflowRun(runId)!;
    if (run.state === "CANCELLED") return;

    // ── PLANNING ────────────────────────────────────────────
    if (run.state === "PRE_REVIEW" || run.state === "REWORK") {
      run = transition(run, "PLANNING", "momo plans");
    } else if (run.state !== "PLANNING") {
      run = transition(run, "PLANNING", "momo plans");
    }
    run.stageTokens.PLANNING = stageToken(run, "PLANNING");
    save(deps, run);
    emit(deps, run, "PLANNING", "Momo 决定执行方式");

    const planPrompt = momoPlanPrompt({
      userRequest: run.userRequest,
      preReview: run.preReview!,
      teamRoster: rosterLines(team),
      reworkRound: run.reworkCount,
      priorFailReason: run.finalReview?.reason,
    });
    const planTurn = await deps.runBotTurn(run.momoBotId, planPrompt, {
      reasoningEffort: run.preReview!.reasoningEffective === "XHIGH" ? "xhigh" : "high",
      label: "momo-plan",
    });
    run = loadWorkflowRun(runId)!;
    if (run.state === "CANCELLED") return;

    let plan = parseMomoPlan(planTurn.text);
    if (!planTurn.ok || !plan) {
      // Fallback: if parse fails but text looks like self-work, treat as SELF only for SIMPLE.
      if (run.preReview!.complexity === "SIMPLE" && planTurn.ok) {
        plan = { decision: "SELF", reason: "parse fallback for SIMPLE task", delegateBotNames: [], at: Date.now() };
      } else {
        run = transition(run, "FAILED", "momo plan parse fail");
        run.error = planTurn.error || "Momo 未返回可解析的执行决策 JSON";
        save(deps, run);
        emit(deps, run, "FAILED", run.error, undefined, false);
        return;
      }
    }

    // Safety: cannot downgrade HIGH-risk auth requirement
    if (run.preReview!.requiresUserAuthorization && plan.decision !== "ESCALATE") {
      plan = {
        ...plan,
        decision: "ESCALATE",
        reason: `强制 ESCALATE：Judge 要求用户授权（原决策 ${plan.decision} 被覆盖）。${plan.reason}`,
      };
    }
    run.plan = plan;
    save(deps, run);
    emit(deps, run, "PLAN_DONE", `Momo 决策 ${plan.decision}`, plan, true);
    deps.postText(
      run.momoThreadId,
      [
        "### Momo 执行决策",
        `- 决策：${plan.decision}`,
        `- 理由：${plan.reason}`,
        plan.decision === "DELEGATE"
          ? `- 委派：${plan.delegateBotNames.join(", ") || "（未点名，将按建议角色匹配）"}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    if (plan.decision === "ESCALATE") {
      run = transition(run, "BLOCKED", "awaiting user authorization");
      run.error = "等待用户授权或补充信息";
      save(deps, run);
      emit(deps, run, "BLOCKED", run.error, plan, false);
      deps.postText(run.momoThreadId, "高风险/需授权：Workflow 已 BLOCKED，请用户确认后重新发起任务。未经 Judge PASS 不算交付。");
      return;
    }

    // ── EXECUTING ───────────────────────────────────────────
    run = transition(run, "EXECUTING", "execute");
    run.stageTokens.EXECUTING = stageToken(run, "EXECUTING");
    save(deps, run);
    emit(deps, run, "EXECUTING", plan.decision === "SELF" ? "Momo 自行执行" : "委派执行");

    const evidence: string[] = [];
    let summary = "";
    let actor: ExecutionRecord["actor"] = "momo";

    if (plan.decision === "SELF") {
      const execTurn = await deps.runBotTurn(
        run.momoBotId,
        momoExecutePrompt({
          userRequest: run.userRequest,
          preReview: run.preReview!,
          planReason: plan.reason,
          mode: "SELF",
        }),
        {
          reasoningEffort: run.preReview!.reasoningEffective === "XHIGH" ? "xhigh" : "high",
          label: "momo-execute",
        },
      );
      run = loadWorkflowRun(runId)!;
      if (run.state === "CANCELLED") return;
      summary = execTurn.text;
      evidence.push(execTurn.text);
      if (!execTurn.ok) {
        run = transition(run, "FAILED", "execute failed");
        run.error = execTurn.error || "Momo 执行失败";
        save(deps, run);
        emit(deps, run, "FAILED", run.error, undefined, false);
        return;
      }
    } else {
      actor = "workers";
      const names =
        plan.delegateBotNames.length > 0
          ? plan.delegateBotNames
          : run.preReview!.recommendedRoles.slice(0, 3);
      const workers = names
        .map((n) => deps.findBotByName(n))
        .filter((b): b is NonNullable<typeof b> => Boolean(b) && b.id !== run.momoBotId && !isJudgeBotName(b.name));
      if (workers.length === 0) {
        // No workers found — Momo leads alone rather than inventing staff.
        actor = "momo";
        const execTurn = await deps.runBotTurn(
          run.momoBotId,
          momoExecutePrompt({
            userRequest: run.userRequest,
            preReview: run.preReview!,
            planReason: plan.reason + "（未找到可委派员工，改由 Momo 自行完成）",
            mode: "SELF",
          }),
          { label: "momo-execute-fallback" },
        );
        run = loadWorkflowRun(runId)!;
        if (run.state === "CANCELLED") return;
        summary = execTurn.text;
        evidence.push(execTurn.text);
      } else {
        const parts: string[] = [];
        for (const w of workers) {
          emit(deps, run, "WORKER", `委派 ${w.name}`);
          const wTurn = await deps.runBotTurn(
            w.id,
            workerExecutePrompt({
              userRequest: run.userRequest,
              preReview: run.preReview!,
              workerName: w.name,
            }),
            { label: `worker-${w.name}` },
          );
          run = loadWorkflowRun(runId)!;
          if (run.state === "CANCELLED") return;
          parts.push(`#### ${w.name}\n${wTurn.text}`);
          evidence.push(`${w.name}: ${wTurn.text}`);
          emit(deps, run, "WORKER_DONE", `${w.name} 完成`, { ok: wTurn.ok }, wTurn.ok);
        }
        // Momo synthesizes
        const lead = await deps.runBotTurn(
          run.momoBotId,
          momoExecutePrompt({
            userRequest: run.userRequest,
            preReview: run.preReview!,
            planReason: `${plan.reason}\n\n员工产出：\n${parts.join("\n\n")}`,
            mode: "DELEGATE_LEAD",
          }),
          { label: "momo-synthesize" },
        );
        run = loadWorkflowRun(runId)!;
        if (run.state === "CANCELLED") return;
        summary = lead.text;
        evidence.push(lead.text);
        actor = "mixed";
      }
    }

    const artifactHash = await hashArtifact([
      run.criteriaVersion,
      run.userRequest,
      ...run.preReview!.acceptanceCriteria,
      summary,
      ...evidence,
      String(run.reworkCount),
    ]);
    run.execution = {
      actor,
      summary,
      evidence,
      artifactHash,
      reworkRound: run.reworkCount,
      at: Date.now(),
    };
    save(deps, run);
    emit(deps, run, "EXEC_DONE", `产物 ${artifactHash}`, { actor, artifactHash }, true);

    // ── FINAL_REVIEW ────────────────────────────────────────
    run = transition(run, "FINAL_REVIEW", "judge final");
    run.stageTokens.FINAL_REVIEW = stageToken(run, "FINAL_REVIEW");
    save(deps, run);
    emit(deps, run, "FINAL_REVIEW", "Judge 最终评审");

    const finalPrompt = judgeFinalReviewPrompt({
      userRequest: run.userRequest,
      preReview: run.preReview!,
      criteriaVersion: run.criteriaVersion,
      artifactHash,
      execution: run.execution,
    });
    const finalTurn = await deps.runBotTurn(run.judgeBotId, finalPrompt, {
      reasoningEffort: canXHigh ? "xhigh" : "high",
      label: "judge-final-review",
    });
    run = loadWorkflowRun(runId)!;
    if (run.state === "CANCELLED") return;

    let review = parseFinalReview(finalTurn.text, run.criteriaVersion, artifactHash);
    if (!finalTurn.ok || !review) {
      run = transition(run, "BLOCKED", "final review unavailable");
      run.error = finalTurn.error || "Judge 最终评审不可用或无法解析；不得自动通过";
      save(deps, run);
      emit(deps, run, "BLOCKED", run.error, { raw: finalTurn.text.slice(0, 800) }, false);
      deps.postText(run.momoThreadId, `Judge 最终评审 BLOCKED：${run.error}`);
      return;
    }
    review = validateFinalBinding(review, run.criteriaVersion, artifactHash);
    run.finalReview = review;
    save(deps, run);

    deps.postText(
      run.momoThreadId,
      [
        "### Judge 最终评审",
        `- 结论：${review.verdict}`,
        `- 理由：${review.reason}`,
        `- criteriaVersion：${review.criteriaVersion}`,
        `- artifactHash：${review.artifactHash}`,
        review.evidenceGaps.length ? `- 证据缺口：${review.evidenceGaps.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    if (review.verdict === "PASS") {
      run = transition(run, "COMPLETED", "accepted");
      save(deps, run);
      emit(deps, run, "COMPLETED", "已验收交付", review, true);
      deps.postText(run.momoThreadId, "### Momo 交付\nJudge 已 PASS。本任务标记为已验收完成。");
      return;
    }

    if (review.verdict === "BLOCKED") {
      run = transition(run, "BLOCKED", review.reason);
      run.error = review.reason;
      save(deps, run);
      emit(deps, run, "BLOCKED", review.reason, review, false);
      return;
    }

    // FAIL → rework
    if (run.reworkCount >= MAX_AUTO_REWORK) {
      run = transition(run, "FAILED", "max rework exceeded");
      run.error = `已达最大自动返工次数 ${MAX_AUTO_REWORK}；最后 FAIL：${review.reason}`;
      save(deps, run);
      emit(deps, run, "FAILED", run.error, review, false);
      deps.postText(run.momoThreadId, `返工次数用尽。${run.error}`);
      return;
    }
    run.reworkCount += 1;
    run = transition(run, "REWORK", `fail rework #${run.reworkCount}`);
    save(deps, run);
    emit(deps, run, "REWORK", `Judge FAIL，进入返工 #${run.reworkCount}`, review, false);
    deps.postText(
      run.momoThreadId,
      `### 返工 #${run.reworkCount}\nJudge FAIL：${review.reason}\nMomo 将重新规划（可 SELF 或 DELEGATE）。`,
    );
    // loop continues → PLANNING
  }
}
