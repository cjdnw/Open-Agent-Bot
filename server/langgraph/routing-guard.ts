/**
 * RoutingGuard — deterministic validation & fallback for Momo routing decisions.
 * Not an LLM. Separates Worker routing from model Fallback.
 */

import type { MomoPlan, PreReview } from "../workflow.ts";
import {
  findWorkerByRole,
  type RegistryLookupResult,
  type WorkerCapability,
  type WorkerRole,
} from "./worker-registry.ts";

export type RoutingSource = "MOMO" | "ROUTING_GUARD";

export interface TaskAssignment {
  role: string;
  objective: string;
  dependsOn?: string[];
}

export interface MomoRoutingDecision {
  executionMode: "SELF" | "DELEGATE" | "ESCALATE";
  selectedRoles: string[];
  decisionReason: string;
  requestedEffort: "HIGH" | "XHIGH";
  taskAssignments?: TaskAssignment[];
  at: number;
}

export type RoutingGuardStatus =
  | "VALID"
  | "INVALID"
  | "RETRY"
  | "FALLBACK"
  | "ESCALATE"
  | "BLOCKED";

export interface RoutingGuardResult {
  status: RoutingGuardStatus;
  routingSource: RoutingSource;
  reason: string;
  selectedRoles: string[];
  executionMode: "SELF" | "DELEGATE" | "ESCALATE" | null;
  fallbackApplied: boolean;
  retryRequested: boolean;
  resolvedWorkers: Array<{ role: string; botId: string; name: string }>;
  taskAssignments: TaskAssignment[];
  detail?: unknown;
}

export const MAX_MOMO_ROUTING_RETRIES = 1;

export function momoPlanToRoutingDecision(plan: MomoPlan | null | undefined): MomoRoutingDecision | null {
  if (!plan) return null;
  const mode = plan.decision;
  if (mode !== "SELF" && mode !== "DELEGATE" && mode !== "ESCALATE") return null;
  return {
    executionMode: mode,
    selectedRoles: plan.delegateBotNames || [],
    decisionReason: plan.reason || "unspecified",
    requestedEffort: plan.requestedEffort === "XHIGH" ? "XHIGH" : "HIGH",
    taskAssignments: plan.taskAssignments,
    at: plan.at || Date.now(),
  };
}

export function detectDependencyCycle(assignments: TaskAssignment[]): boolean {
  if (!assignments.length) return false;
  const deps = new Map<string, string[]>();
  for (const a of assignments) {
    deps.set(a.role, a.dependsOn || []);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of deps.get(node) || []) {
      if (dfs(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const role of deps.keys()) {
    if (dfs(role)) return true;
  }
  return false;
}

function resolveWorkers(
  roles: string[],
  registry: RegistryLookupResult,
): {
  ok: boolean;
  resolved: Array<{ role: string; botId: string; name: string }>;
  errors: string[];
} {
  const resolved: Array<{ role: string; botId: string; name: string }> = [];
  const errors: string[] = [];

  for (const role of roles) {
    const worker = findWorkerByRole(registry.workers, role);
    if (!worker) {
      errors.push(`员工不存在或未注册：${role}`);
      continue;
    }
    if (worker.availability === "OFFLINE") {
      errors.push(`${worker.role} OFFLINE，禁止调度`);
      continue;
    }
    if (worker.availability === "BUSY") {
      errors.push(`${worker.role} BUSY，禁止重复启动`);
      continue;
    }
    resolved.push({ role: worker.role, botId: worker.botId, name: worker.name });
  }

  return { ok: errors.length === 0 && (roles.length === 0 || resolved.length === roles.length), resolved, errors };
}

function toolPermissionErrors(workers: WorkerCapability[], requiresSsh: boolean): string[] {
  const errors: string[] = [];
  if (!requiresSsh) return errors;
  for (const w of workers) {
    if (!w.allowedOperations.includes("ssh") && !w.requiredTools.includes("ssh")) {
      errors.push(`${w.role} 无 SSH 权限，不能执行必须 SSH 的任务`);
    }
  }
  return errors;
}

function uniqueSafeFallback(
  pre: PreReview,
  registry: RegistryLookupResult,
  userRequest: string,
  approvalGranted: boolean | null | undefined,
): RoutingGuardResult {
  if (pre.requiresUserAuthorization && approvalGranted !== true) {
    return {
      status: "ESCALATE",
      routingSource: "ROUTING_GUARD",
      reason: "Momo 决策失败且任务仍需人工授权，不得默认执行高风险操作",
      selectedRoles: [],
      executionMode: "ESCALATE",
      fallbackApplied: true,
      retryRequested: false,
      resolvedWorkers: [],
      taskAssignments: [],
    };
  }

  const requiresSsh = /ssh|远程|rk3576|部署/i.test(userRequest);
  const candidates: WorkerCapability[] = [];

  for (const role of pre.recommendedRoles) {
    const w = findWorkerByRole(registry.workers, role);
    if (!w) continue;
    if (w.availability !== "AVAILABLE" && w.availability !== "UNKNOWN") continue;
    if (requiresSsh && !w.allowedOperations.includes("ssh") && !w.requiredTools.includes("ssh")) continue;
    candidates.push(w);
  }

  // If Judge gave no roles, pick top available match from registry scores
  if (candidates.length === 0) {
    for (const m of registry.matchReasons) {
      if (!m.matched || !m.botId) continue;
      const w = registry.workers.find((x) => x.botId === m.botId);
      if (!w) continue;
      if (w.availability !== "AVAILABLE" && w.availability !== "UNKNOWN") continue;
      if (requiresSsh && !w.allowedOperations.includes("ssh")) continue;
      candidates.push(w);
      break;
    }
  }

  const uniqueRoles = [...new Set(candidates.map((c) => c.role))];
  if (uniqueRoles.length === 1 && candidates.length >= 1) {
    const w = candidates[0]!;
    return {
      status: "FALLBACK",
      routingSource: "ROUTING_GUARD",
      reason: "Momo 未返回有效结构化决策；RoutingGuard 选择唯一、安全、可执行的 Worker",
      selectedRoles: [w.role],
      executionMode: "DELEGATE",
      fallbackApplied: true,
      retryRequested: false,
      resolvedWorkers: [{ role: w.role, botId: w.botId, name: w.name }],
      taskAssignments: [{ role: w.role, objective: userRequest }],
      detail: { routingSource: "ROUTING_GUARD", fallbackApplied: true, selectedRoles: [w.role] },
    };
  }

  if (uniqueRoles.length > 1) {
    return {
      status: "ESCALATE",
      routingSource: "ROUTING_GUARD",
      reason: `存在多个无法可靠区分的执行方案：${uniqueRoles.join(", ")}`,
      selectedRoles: uniqueRoles,
      executionMode: "ESCALATE",
      fallbackApplied: true,
      retryRequested: false,
      resolvedWorkers: [],
      taskAssignments: [],
    };
  }

  return {
    status: "BLOCKED",
    routingSource: "ROUTING_GUARD",
    reason: "没有任何可执行的合法 Worker 方案",
    selectedRoles: [],
    executionMode: null,
    fallbackApplied: true,
    retryRequested: false,
    resolvedWorkers: [],
    taskAssignments: [],
  };
}

/**
 * Validate Momo decision against WorkerRegistry and safety constraints.
 * retryCount: number of correction attempts already performed (max 1).
 */
export function validateMomoRouting(input: {
  decision: MomoRoutingDecision | null;
  preReview: PreReview;
  registry: RegistryLookupResult;
  userRequest: string;
  approvalGranted?: boolean | null;
  retryCount: number;
}): RoutingGuardResult {
  const { decision, preReview, registry, userRequest, approvalGranted, retryCount } = input;
  const requiresSsh = /ssh|远程|rk3576|部署生产/i.test(userRequest);

  if (!decision) {
    if (retryCount < MAX_MOMO_ROUTING_RETRIES) {
      return {
        status: "RETRY",
        routingSource: "MOMO",
        reason: "Momo 未返回有效结构化决策，要求重新决策",
        selectedRoles: [],
        executionMode: null,
        fallbackApplied: false,
        retryRequested: true,
        resolvedWorkers: [],
        taskAssignments: [],
      };
    }
    return uniqueSafeFallback(preReview, registry, userRequest, approvalGranted);
  }

  if (decision.executionMode === "ESCALATE") {
    return {
      status: "ESCALATE",
      routingSource: "MOMO",
      reason: decision.decisionReason || "Momo 请求人工处理",
      selectedRoles: decision.selectedRoles,
      executionMode: "ESCALATE",
      fallbackApplied: false,
      retryRequested: false,
      resolvedWorkers: [],
      taskAssignments: decision.taskAssignments || [],
    };
  }

  if (preReview.requiresUserAuthorization && approvalGranted !== true) {
    return {
      status: "ESCALATE",
      routingSource: "ROUTING_GUARD",
      reason: "高风险任务未授权，禁止执行（含 SELF）",
      selectedRoles: [],
      executionMode: "ESCALATE",
      fallbackApplied: false,
      retryRequested: false,
      resolvedWorkers: [],
      taskAssignments: [],
    };
  }

  if (decision.executionMode === "SELF") {
    // SELF is always allowed when authorization/risk rules pass — even if Judge recommended workers.
    return {
      status: "VALID",
      routingSource: "MOMO",
      reason: decision.decisionReason || "Momo 选择 SELF",
      selectedRoles: [],
      executionMode: "SELF",
      fallbackApplied: false,
      retryRequested: false,
      resolvedWorkers: [],
      taskAssignments: [],
    };
  }

  if (decision.executionMode === "DELEGATE") {
    const roles =
      decision.selectedRoles.length > 0
        ? decision.selectedRoles
        : preReview.recommendedRoles.length > 0
          ? preReview.recommendedRoles
          : [];

    if (roles.length === 0) {
      if (retryCount < MAX_MOMO_ROUTING_RETRIES) {
        return {
          status: "RETRY",
          routingSource: "MOMO",
          reason: "DELEGATE 未指定 selectedRoles",
          selectedRoles: [],
          executionMode: "DELEGATE",
          fallbackApplied: false,
          retryRequested: true,
          resolvedWorkers: [],
          taskAssignments: [],
        };
      }
      return uniqueSafeFallback(preReview, registry, userRequest, approvalGranted);
    }

    // Reject unknown roles explicitly — do not silently substitute.
    for (const role of roles) {
      if (!findWorkerByRole(registry.workers, role)) {
        if (retryCount < MAX_MOMO_ROUTING_RETRIES) {
          return {
            status: "RETRY",
            routingSource: "MOMO",
            reason: `选择了不存在的员工：${role}，请重新选择`,
            selectedRoles: roles,
            executionMode: "DELEGATE",
            fallbackApplied: false,
            retryRequested: true,
            resolvedWorkers: [],
            taskAssignments: decision.taskAssignments || [],
          };
        }
        return {
          status: "BLOCKED",
          routingSource: "ROUTING_GUARD",
          reason: `员工不存在：${role}；重试后仍无效`,
          selectedRoles: roles,
          executionMode: null,
          fallbackApplied: true,
          retryRequested: false,
          resolvedWorkers: [],
          taskAssignments: [],
        };
      }
    }

    const assignments = decision.taskAssignments || roles.map((role) => ({ role, objective: userRequest }));
    if (detectDependencyCycle(assignments)) {
      return {
        status: "INVALID",
        routingSource: "MOMO",
        reason: "多 Worker 依赖形成环，拒绝执行",
        selectedRoles: roles,
        executionMode: "DELEGATE",
        fallbackApplied: false,
        retryRequested: retryCount < MAX_MOMO_ROUTING_RETRIES,
        resolvedWorkers: [],
        taskAssignments: assignments,
      };
    }

    const resolved = resolveWorkers(roles, registry);
    if (!resolved.ok) {
      if (retryCount < MAX_MOMO_ROUTING_RETRIES) {
        return {
          status: "RETRY",
          routingSource: "MOMO",
          reason: resolved.errors.join("; "),
          selectedRoles: roles,
          executionMode: "DELEGATE",
          fallbackApplied: false,
          retryRequested: true,
          resolvedWorkers: resolved.resolved,
          taskAssignments: assignments,
        };
      }
      // Try fallback only if original roles unavailable
      const fb = uniqueSafeFallback(preReview, registry, userRequest, approvalGranted);
      if (fb.status === "FALLBACK") return fb;
      return {
        status: "BLOCKED",
        routingSource: "ROUTING_GUARD",
        reason: resolved.errors.join("; "),
        selectedRoles: roles,
        executionMode: null,
        fallbackApplied: true,
        retryRequested: false,
        resolvedWorkers: [],
        taskAssignments: assignments,
      };
    }

    const workerObjs = resolved.resolved
      .map((r) => registry.workers.find((w) => w.botId === r.botId))
      .filter((w): w is WorkerCapability => Boolean(w));
    const toolErrors = toolPermissionErrors(workerObjs, requiresSsh);
    if (toolErrors.length) {
      return {
        status: "BLOCKED",
        routingSource: "ROUTING_GUARD",
        reason: toolErrors.join("; "),
        selectedRoles: roles,
        executionMode: null,
        fallbackApplied: false,
        retryRequested: false,
        resolvedWorkers: resolved.resolved,
        taskAssignments: assignments,
      };
    }

    return {
      status: "VALID",
      routingSource: "MOMO",
      reason: decision.decisionReason || "DELEGATE 校验通过",
      selectedRoles: resolved.resolved.map((r) => r.role),
      executionMode: "DELEGATE",
      fallbackApplied: false,
      retryRequested: false,
      resolvedWorkers: resolved.resolved,
      taskAssignments: assignments,
    };
  }

  if (retryCount < MAX_MOMO_ROUTING_RETRIES) {
    return {
      status: "RETRY",
      routingSource: "MOMO",
      reason: `无效 executionMode：${(decision as MomoRoutingDecision).executionMode}`,
      selectedRoles: [],
      executionMode: null,
      fallbackApplied: false,
      retryRequested: true,
      resolvedWorkers: [],
      taskAssignments: [],
    };
  }

  return uniqueSafeFallback(preReview, registry, userRequest, approvalGranted);
}

export function routingGuardToMomoPlan(result: RoutingGuardResult): MomoPlan | null {
  if (!result.executionMode) return null;
  return {
    decision: result.executionMode,
    reason:
      result.routingSource === "ROUTING_GUARD"
        ? `[ROUTING_GUARD] ${result.reason}`
        : result.reason,
    delegateBotNames: result.selectedRoles,
    requestedEffort: "HIGH",
    taskAssignments: result.taskAssignments,
    at: Date.now(),
  };
}

export type { WorkerRole };
