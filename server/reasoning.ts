// Shared reasoning-effort helpers. The wire form is "low" | "medium" |
// "high" | "xhigh". Product policy for Xinyun 6-bot deploy: only high/xhigh
// are target tiers; low/medium remain parseable for older clients.
import type { ReasoningEffort } from "./contracts.ts";

const ALLOWED = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

/** Parse a wire value into a ReasoningEffort, or undefined when absent/invalid. */
export function parseReasoningEffort(raw: unknown): ReasoningEffort | undefined {
  if (typeof raw !== "string") return undefined;
  return ALLOWED.has(raw as ReasoningEffort) ? (raw as ReasoningEffort) : undefined;
}

/** Drivers that accept an effort parameter on turn start. */
export function providerSupportsEffort(instanceId: string, driver?: string): boolean {
  const id = instanceId.toLowerCase();
  const d = (driver ?? "").toLowerCase();
  if (id === "codex" || d === "codex") return true;
  if (id === "deepseek-aliyun" || id === "deepseek" || id === "ninebot" || d === "grok") return true;
  // Claude Code CLI: `--effort <low|medium|high|xhigh|max>` (verified on 2.1.x).
  if (id === "claude" || d === "claude" || d === "claudeagent") return true;
  // Cursor / Antigravity: model id often embeds *-high; no separate effort param here.
  return false;
}

/** Whether the provider can honestly honor XHigh (not silently map to high). */
export function providerSupportsXHigh(instanceId: string, driver?: string, model?: string): boolean {
  const id = instanceId.toLowerCase();
  const d = (driver ?? "").toLowerCase();
  // Codex CLI passes effort through to turn/start — xhigh is accepted when the
  // underlying GPT model supports it. We allow claiming xhigh for codex only.
  if (id === "codex" || d === "codex") return true;
  // Claude Code CLI documents xhigh (and max); we pass xhigh through as-is.
  if (id === "claude" || d === "claude" || d === "claudeagent") return true;
  // Bailian / Ninebot OpenAI-compat: reasoning_effort may accept xhigh on some
  // models; we do NOT claim support until verified — return false.
  void model;
  return false;
}
