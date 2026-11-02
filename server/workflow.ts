/**
 * Momo → Worker → Judge Workflow contract (v0.2.0).
 *
 * This module defines the orchestration vocabulary used by Chief-of-Staff
 * (Momo) dispatch. Runtime still rides the existing agents MCP (`ask_bot` /
 * `list_bots`) and LogicalTurn ledger — we do not invent a second engine here.
 */

export type WorkflowRole = "momo" | "worker" | "judge";

export type JudgeVerdict = "PASS" | "FAIL" | "BLOCKED";

export interface WorkflowStep {
  stepId: string;
  role: WorkflowRole;
  botId: string;
  goal: string;
  /** When role === "judge", only these answers are valid. */
  allowedVerdicts?: readonly JudgeVerdict[];
}

export interface WorkflowRun {
  runId: string;
  momoBotId: string;
  createdAt: number;
  steps: WorkflowStep[];
  /** LogicalTurn ids created while executing this run (filled by orchestrator). */
  logicalTurnIds: string[];
}

export const JUDGE_VERDICTS = ["PASS", "FAIL", "BLOCKED"] as const satisfies readonly JudgeVerdict[];

export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  const m = text.trim().toUpperCase().match(/\b(PASS|FAIL|BLOCKED)\b/);
  return m ? (m[1] as JudgeVerdict) : null;
}

export function isJudgeVerdict(text: string): boolean {
  return parseJudgeVerdict(text) !== null;
}
