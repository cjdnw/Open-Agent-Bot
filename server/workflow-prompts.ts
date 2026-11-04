import type { ExecutionRecord, PreReview } from "./workflow.ts";

export function judgePreReviewPrompt(input: {
  taskId: string;
  userRequest: string;
  teamRoster: string;
  canXHigh: boolean;
}): string {
  return [
    "你是独立评审官 Judge。现在只做【任务前置评估】，不要执行任务，不要委派，不要给出最终 PASS/FAIL。",
    "必须根据任务内容真实判断难度：简单任务评 SIMPLE，中等 MODERATE，复杂 COMPLEX。禁止把所有任务都评为 COMPLEX。",
    "难度 complexity 与风险 riskLevel 分开判断：简单任务也可能是 HIGH 风险。",
    "recommendedRoles 只是建议，不强制执行者；不要直接调用 Worker。",
    "可用 roleReasons 说明每个推荐角色的原因；不得自行放宽用户验收约束。",
    `reasoningRecommendation 只能是 HIGH 或 XHIGH。当前执行栈${input.canXHigh ? "可以" : "不能"}诚实支持 XHIGH；若不能支持 XHIGH，请推荐 HIGH。`,
    "acceptanceCriteria 必须可验证，并保留用户原始约束。",
    "若 riskLevel=HIGH，requiresUserAuthorization 通常应为 true。",
    "只输出一个 JSON 对象（可包在 ```json 代码块中），字段：",
    JSON.stringify(
      {
        taskId: input.taskId,
        complexity: "SIMPLE|MODERATE|COMPLEX",
        riskLevel: "LOW|MEDIUM|HIGH",
        reasoningRecommendation: "HIGH|XHIGH",
        difficultyReason: "string",
        recommendedRoles: ["Developer", "QA"],
        roleReasons: { Developer: "需要改代码", QA: "需要独立验证" },
        acceptanceCriteria: ["..."],
        requiredEvidence: ["..."],
        riskWarnings: ["..."],
        requiresUserAuthorization: false,
      },
      null,
      2,
    ),
    "",
    "团队角色参考：",
    input.teamRoster,
    "",
    "用户任务：",
    input.userRequest,
  ].join("\n");
}

export function momoPlanPrompt(input: {
  userRequest: string;
  preReview: PreReview;
  teamRoster: string;
  reworkRound: number;
  priorFailReason?: string;
  workerRegistryText?: string;
  correctionHint?: string;
}): string {
  return [
    "你是总管 Momo。Judge 已完成前置评估。请自主决定怎么做，不要假装自己是 Judge，不要输出 PASS/FAIL/BLOCKED。",
    "当前【协作流已开启】。禁止声称「协作流已关闭 / 只能自干 / 不委派」；那是错误前提。",
    "可选 executionMode/decision：SELF（自己做）、DELEGATE（委派一个或多个员工）、ESCALATE（需要用户批准或补充信息）。",
    "规则：",
    "- 可以拒绝 Judge 的员工推荐并选择 SELF，但必须说明理由。",
    "- DELEGATE 时 selectedRoles/delegateBotNames 必须使用 Registry 中真实角色名（Architect/Developer/Deploy/QA/Reporter）。",
    "- 可用 taskAssignments 描述多员工依赖；dependsOn 不得成环。",
    "- 不得违反工具权限、数据授权或未完成的高风险审批。",
    "- 若 requiresUserAuthorization=true 且尚未批准，必须 ESCALATE。",
    input.correctionHint ? `RoutingGuard 要求修正：${input.correctionHint}` : "",
    input.reworkRound > 0
      ? `这是第 ${input.reworkRound} 轮返工。上次 Judge FAIL 原因：${input.priorFailReason || "未说明"}。`
      : "",
    "只输出 JSON：",
    JSON.stringify(
      {
        executionMode: "SELF|DELEGATE|ESCALATE",
        decisionReason: "string",
        selectedRoles: ["Developer"],
        requestedEffort: "HIGH|XHIGH",
        taskAssignments: [{ role: "Developer", objective: "...", dependsOn: [] }],
      },
      null,
      2,
    ),
    "",
    "Judge 前置评估：",
    JSON.stringify(input.preReview, null, 2),
    "",
    "WorkerRegistry（实时能力与可用性）：",
    input.workerRegistryText || input.teamRoster,
    "",
    "团队名录：",
    input.teamRoster,
    "",
    "用户任务：",
    input.userRequest,
  ]
    .filter(Boolean)
    .join("\n");
}

export function momoExecutePrompt(input: {
  userRequest: string;
  preReview: PreReview;
  planReason: string;
  mode: "SELF" | "DELEGATE_LEAD";
}): string {
  return [
    "你是总管 Momo，正在执行已锁定验收标准的任务。",
    "不要模拟 Judge，不要自行宣布 PASS/FAIL/BLOCKED。完成后如实汇报证据与结果。",
    `执行模式：${input.mode === "SELF" ? "自行完成" : "你可以委派员工，但你负责汇总"}。`,
    "理由：" + input.planReason,
    "",
    "锁定的验收标准：",
    input.preReview.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    "",
    "所需证据：",
    input.preReview.requiredEvidence.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(无额外)",
    "",
    "风险警告：",
    input.preReview.riskWarnings.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(无)",
    "",
    "用户任务：",
    input.userRequest,
  ].join("\n");
}

export function workerExecutePrompt(input: {
  userRequest: string;
  preReview: PreReview;
  workerName: string;
}): string {
  return [
    `你是专业员工 ${input.workerName}。请完成总管分配的子任务，返回可验证证据。`,
    "不要扮演 Judge，不要输出最终验收结论。",
    "",
    "验收标准（供你对齐产出，最终仍由 Judge 评审）：",
    input.preReview.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    "",
    "任务：",
    input.userRequest,
  ].join("\n");
}

export function judgeFinalReviewPrompt(input: {
  userRequest: string;
  preReview: PreReview;
  criteriaVersion: string;
  artifactHash: string;
  execution: ExecutionRecord;
}): string {
  return [
    "你是独立评审官 Judge。现在做【最终评审】。",
    "只能依据锁定的验收标准与证据判断，不得因执行者自称完成而 PASS。",
    "不得修改验收标准或被审产物。",
    "verdict 只能是 PASS / FAIL / BLOCKED。证据不足时必须 BLOCKED，不能当作 PASS。",
    "返回 JSON 时必须原样带回 criteriaVersion 与 artifactHash（绑定当前产物，禁止复用过期 PASS）。",
    "",
    JSON.stringify(
      {
        verdict: "PASS|FAIL|BLOCKED",
        reason: "string",
        criteriaVersion: input.criteriaVersion,
        artifactHash: input.artifactHash,
        evidenceGaps: ["..."],
      },
      null,
      2,
    ),
    "",
    "原始用户请求：",
    input.userRequest,
    "",
    "前置评估（含锁定验收标准）：",
    JSON.stringify(
      {
        complexity: input.preReview.complexity,
        riskLevel: input.preReview.riskLevel,
        acceptanceCriteria: input.preReview.acceptanceCriteria,
        requiredEvidence: input.preReview.requiredEvidence,
        riskWarnings: input.preReview.riskWarnings,
      },
      null,
      2,
    ),
    "",
    `criteriaVersion=${input.criteriaVersion}`,
    `artifactHash=${input.artifactHash}`,
    "",
    "执行记录：",
    JSON.stringify(input.execution, null, 2),
  ].join("\n");
}
