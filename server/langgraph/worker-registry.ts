/**
 * WorkerRegistry — capability discovery for the five existing Workers.
 * botId always comes from the live Bot store; never invents bots.
 */

export type WorkerRole = "Architect" | "Developer" | "Deploy" | "QA" | "Reporter";
export type WorkerAvailability = "AVAILABLE" | "BUSY" | "OFFLINE" | "UNKNOWN";

export interface WorkerCapability {
  botId: string;
  role: WorkerRole;
  name: string;
  title?: string;
  capabilities: string[];
  supportedTaskTypes: string[];
  availability: WorkerAvailability;
  requiredTools: string[];
  allowedOperations: string[];
  priority: number;
}

export interface WorkerMatchReason {
  role: string;
  botId?: string;
  matched: boolean;
  reason: string;
  score: number;
}

export interface RegistryLookupResult {
  workers: WorkerCapability[];
  matchReasons: WorkerMatchReason[];
  at: number;
}

export interface TeamBotRef {
  id: string;
  name: string;
  title?: string;
  busy?: boolean;
  offline?: boolean;
  /** Optional capability tags from bot config / title. */
  capabilityTags?: string[];
  allowedOperations?: string[];
  requiredTools?: string[];
}

const ROLE_CATALOG: Record<
  WorkerRole,
  {
    aliases: string[];
    capabilities: string[];
    supportedTaskTypes: string[];
    requiredTools: string[];
    allowedOperations: string[];
    priority: number;
  }
> = {
  Architect: {
    aliases: ["architect", "架构", "架构师"],
    capabilities: ["算法研究", "网络设计", "技术架构", "模型优化", "系统设计"],
    supportedTaskTypes: ["architecture", "algorithm", "design", "optimization"],
    requiredTools: [],
    allowedOperations: ["read", "analyze", "design"],
    priority: 40,
  },
  Developer: {
    aliases: ["developer", "dev", "开发", "工程师"],
    capabilities: ["C++", "Python", "代码修改", "Debug", "工程开发"],
    supportedTaskTypes: ["code", "cpp", "python", "debug", "implement"],
    requiredTools: [],
    allowedOperations: ["read", "write", "edit", "git"],
    priority: 50,
  },
  Deploy: {
    aliases: ["deploy", "部署", "运维"],
    capabilities: ["RKNN", "RK3576", "Linux", "SSH", "性能优化", "模型部署"],
    supportedTaskTypes: ["deploy", "rknn", "ssh", "linux", "perf"],
    requiredTools: ["ssh"],
    allowedOperations: ["read", "write", "shell", "ssh", "deploy"],
    priority: 60,
  },
  QA: {
    aliases: ["qa", "测试", "质量"],
    capabilities: ["测试", "回归验证", "日志核查", "指标分析"],
    supportedTaskTypes: ["test", "regression", "metrics", "log"],
    requiredTools: [],
    allowedOperations: ["read", "test", "analyze"],
    priority: 45,
  },
  Reporter: {
    aliases: ["reporter", "报告", "文档"],
    capabilities: ["文档编写", "实验报告", "数据汇总", "结果整理"],
    supportedTaskTypes: ["docs", "report", "summary"],
    requiredTools: [],
    allowedOperations: ["read", "write", "docs"],
    priority: 30,
  },
};

const ROLE_ORDER: WorkerRole[] = ["Architect", "Developer", "Deploy", "QA", "Reporter"];

export function normalizeWorkerRole(raw: string): WorkerRole | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  for (const role of ROLE_ORDER) {
    if (role.toLowerCase() === t) return role;
    if (ROLE_CATALOG[role].aliases.some((a) => t === a || t.includes(a) || a.includes(t))) {
      return role;
    }
  }
  return null;
}

function availabilityOf(bot: TeamBotRef): WorkerAvailability {
  if (bot.offline === true) return "OFFLINE";
  if (bot.busy === true) return "BUSY";
  if (bot.offline === undefined && bot.busy === undefined) return "UNKNOWN";
  return "AVAILABLE";
}

function inferRole(bot: TeamBotRef): WorkerRole | null {
  const fromName = normalizeWorkerRole(bot.name);
  if (fromName) return fromName;
  if (bot.title) {
    const fromTitle = normalizeWorkerRole(bot.title);
    if (fromTitle) return fromTitle;
  }
  return null;
}

export function buildWorkerCapabilities(team: TeamBotRef[]): WorkerCapability[] {
  const out: WorkerCapability[] = [];
  for (const bot of team) {
    const role = inferRole(bot);
    if (!role) continue;
    const catalog = ROLE_CATALOG[role];
    const extraCaps = bot.capabilityTags || [];
    out.push({
      botId: bot.id,
      role,
      name: bot.name,
      title: bot.title,
      capabilities: [...catalog.capabilities, ...extraCaps],
      supportedTaskTypes: [...catalog.supportedTaskTypes],
      availability: availabilityOf(bot),
      requiredTools: bot.requiredTools?.length ? bot.requiredTools : [...catalog.requiredTools],
      allowedOperations: bot.allowedOperations?.length
        ? bot.allowedOperations
        : [...catalog.allowedOperations],
      priority: catalog.priority,
    });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

export function findWorkerByRole(
  workers: WorkerCapability[],
  roleOrName: string,
): WorkerCapability | undefined {
  const role = normalizeWorkerRole(roleOrName);
  if (role) {
    const byRole = workers.find((w) => w.role === role);
    if (byRole) return byRole;
  }
  const lower = roleOrName.trim().toLowerCase();
  return workers.find(
    (w) => w.name.toLowerCase() === lower || w.role.toLowerCase() === lower,
  );
}

/** Tokenize a user/Judge request for soft capability scoring (extensible, not fixed-only). */
export function scoreWorkerForTask(
  worker: WorkerCapability,
  taskText: string,
  requiredOps: string[] = [],
  requiredTools: string[] = [],
): WorkerMatchReason {
  const hay = `${taskText} ${worker.capabilities.join(" ")} ${worker.supportedTaskTypes.join(" ")}`.toLowerCase();
  let score = worker.priority / 100;
  const hits: string[] = [];

  for (const cap of worker.capabilities) {
    if (taskText.toLowerCase().includes(cap.toLowerCase())) {
      score += 2;
      hits.push(cap);
    }
  }
  for (const t of worker.supportedTaskTypes) {
    if (taskText.toLowerCase().includes(t.toLowerCase())) {
      score += 1.5;
      hits.push(t);
    }
  }

  for (const tool of requiredTools) {
    if (worker.requiredTools.includes(tool) || worker.allowedOperations.includes(tool)) {
      score += 2;
      hits.push(`tool:${tool}`);
    } else if (tool === "ssh" && !worker.allowedOperations.includes("ssh")) {
      return {
        role: worker.role,
        botId: worker.botId,
        matched: false,
        reason: `${worker.role} 不具备 SSH 权限/能力，不能分配必须 SSH 的任务`,
        score: -1,
      };
    }
  }

  for (const op of requiredOps) {
    if (!worker.allowedOperations.includes(op) && !worker.allowedOperations.includes("write")) {
      if (["shell", "ssh", "deploy", "write", "edit"].includes(op)) {
        return {
          role: worker.role,
          botId: worker.botId,
          matched: false,
          reason: `${worker.role} 不允许操作 ${op}`,
          score: -1,
        };
      }
    }
  }

  if (worker.availability === "OFFLINE") {
    return {
      role: worker.role,
      botId: worker.botId,
      matched: false,
      reason: `${worker.role} 当前 OFFLINE`,
      score: -1,
    };
  }
  if (worker.availability === "BUSY") {
    return {
      role: worker.role,
      botId: worker.botId,
      matched: false,
      reason: `${worker.role} 当前 BUSY，不可重复启动`,
      score: 0,
    };
  }

  const matched = score > 0.5 || hits.length > 0 || hay.length > 0;
  const available =
    worker.availability === "AVAILABLE" || worker.availability === "UNKNOWN";
  return {
    role: worker.role,
    botId: worker.botId,
    matched: matched && available,
    reason: hits.length
      ? `匹配能力：${hits.slice(0, 6).join(", ")}；可用性=${worker.availability}`
      : `角色 ${worker.role} 候选；可用性=${worker.availability}`,
    score,
  };
}

export function inferRequiredTools(userRequest: string, riskLevel?: string): string[] {
  const tools: string[] = [];
  const t = userRequest.toLowerCase();
  if (/(ssh|scp|rsync|远程)/i.test(t)) tools.push("ssh");
  if (/(部署|deploy|rk3576|rknn)/i.test(t)) tools.push("deploy");
  if (/(删除|rm\s+-rf|生产)/i.test(t) || riskLevel === "HIGH") tools.push("shell");
  return tools;
}

export function lookupWorkersForTask(
  team: TeamBotRef[],
  userRequest: string,
  recommendedRoles: string[] = [],
  riskLevel?: string,
): RegistryLookupResult {
  const workers = buildWorkerCapabilities(team);
  const requiredTools = inferRequiredTools(userRequest, riskLevel);
  const matchReasons: WorkerMatchReason[] = [];

  for (const role of recommendedRoles) {
    const w = findWorkerByRole(workers, role);
    if (!w) {
      matchReasons.push({
        role,
        matched: false,
        reason: `Judge 推荐角色 ${role} 在当前团队中无对应 Bot`,
        score: -1,
      });
      continue;
    }
    matchReasons.push(scoreWorkerForTask(w, userRequest, [], requiredTools));
  }

  for (const w of workers) {
    if (matchReasons.some((m) => m.botId === w.botId)) continue;
    matchReasons.push(scoreWorkerForTask(w, userRequest, [], requiredTools));
  }

  matchReasons.sort((a, b) => b.score - a.score);
  return { workers, matchReasons, at: Date.now() };
}

export function formatRegistryForPrompt(lookup: RegistryLookupResult): string {
  if (!lookup.workers.length) return "- (no workers registered)";
  return lookup.workers
    .map((w) => {
      const match = lookup.matchReasons.find((m) => m.botId === w.botId);
      return `- ${w.role} / ${w.name} (id=${w.botId}) avail=${w.availability} caps=[${w.capabilities.join(", ")}] ops=[${w.allowedOperations.join(", ")}]${match ? ` match=${match.reason}` : ""}`;
    })
    .join("\n");
}
