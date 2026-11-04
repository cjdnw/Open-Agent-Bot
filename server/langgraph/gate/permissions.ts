import type { RouteLevel } from "../types.ts";

export type GateOperationKind =
  | "chat"
  | "readonly"
  | "write_file"
  | "git_write"
  | "shell"
  | "ssh"
  | "deploy"
  | "formal_delivery";

/**
 * Runtime permission check independent of model classification.
 * Classification never grants tools; this gate decides whether an op is allowed
 * on the current route, or requires upgrade before execution.
 */
export function evaluateGateOperation(
  routeLevel: RouteLevel,
  op: GateOperationKind,
): { allowed: boolean; upgradeTo?: RouteLevel; reason: string } {
  if (routeLevel === "L0") {
    if (op === "chat") return { allowed: true, reason: "L0 chat only" };
    return {
      allowed: false,
      upgradeTo: op === "ssh" || op === "deploy" || op === "shell" ? "L3" : "L2",
      reason: `L0 禁止操作 ${op}，需先升级`,
    };
  }

  if (routeLevel === "L1") {
    if (op === "chat" || op === "readonly") return { allowed: true, reason: "L1 readonly/chat" };
    return {
      allowed: false,
      upgradeTo: op === "ssh" || op === "deploy" || op === "shell" ? "L3" : "L2",
      reason: `L1 禁止写/外部操作 ${op}，需先升级`,
    };
  }

  // L2/L3: formal workflow already owns authorization / Judge.
  return { allowed: true, reason: `formal path ${routeLevel} defers to Judge/approval` };
}

export function detectUpgradeIntentFromText(text: string): GateOperationKind | null {
  if (/(ssh|scp|rsync|远程)/i.test(text)) return "ssh";
  if (/(部署|deploy|rk3576|rknn)/i.test(text)) return "deploy";
  if (/(rm\s+-rf|删除数据库|drop\s+table)/i.test(text)) return "shell";
  if (/(git\s+commit|git\s+push|写入|写文件|修改文件)/i.test(text)) return "git_write";
  if (/(修改|实现|修复|创建文件)/i.test(text)) return "write_file";
  if (/(交付|验收|正式报告)/i.test(text)) return "formal_delivery";
  return null;
}
