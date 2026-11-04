/**
 * Ensure a visible "Gate" bot exists for AI Gate classification.
 * Uses Antigravity gemini-3.8-flash-low (light thinking) — not high.
 * No Bot F_final chain: routing disabled / empty fallbacks.
 */
import type { ModelSelection } from "../../contracts.ts";
import type { BotRecord } from "../../store.ts";
import { AI_GATE_MODEL_ID, AI_GATE_PROVIDER } from "./types.ts";

export function isGateBotName(name: string): boolean {
  return /^gate$/i.test(name.trim());
}

export function isWorkflowInfrastructureBot(name: string): boolean {
  return isGateBotName(name) || /^judge$/i.test(name.trim());
}

const GATE_TITLE = "AI Task Gate / Lightweight Classifier";
const GATE_DESCRIPTION = [
  "Open-Agent-Bot 入口任务分类器（AI Gate）。",
  "只负责把用户消息分到 L0/L1/L2/L3，不执行任务、不调用 Worker、不做 Judge 验收。",
  `主模型：Antigravity ${AI_GATE_MODEL_ID}（轻量思考，非 High）。`,
  "模型失败时由本地 Rule Fallback 接管；不走全局 F_final。",
].join("\n");

export function gateBotModelSelection(): ModelSelection {
  return { instanceId: AI_GATE_PROVIDER, model: AI_GATE_MODEL_ID };
}

export function ensureGateBot(store: {
  bots: BotRecord[];
  createBot: () => BotRecord;
  patchBot: (id: string, patch: Partial<BotRecord>) => BotRecord | null;
  appendMessage?: (threadId: string, msg: { role: "bot"; kind: "text" | "activity"; text?: string; tool?: { name: string; ok?: boolean } }) => unknown;
}): BotRecord {
  let gate = store.bots.find((b) => isGateBotName(b.name));
  const selection = gateBotModelSelection();

  if (!gate) {
    gate = store.createBot();
    store.patchBot(gate.id, {
      name: "Gate",
      title: GATE_TITLE,
      description: GATE_DESCRIPTION,
      color: "cyan",
      hidden: false,
      pinned: true,
      chiefOfStaff: false,
      collaborationWorkflow: false,
      computer: "off",
      autoApprove: false,
      alwaysAllow: [],
      modelSelection: selection,
      modelRouting: {
        enabled: false,
        primary: {
          instanceId: selection.instanceId,
          model: selection.model,
          label: `Antigravity ${selection.model}`,
        },
        fallbacks: [],
        // Schema only allows high|xhigh; light thinking is the *-low model id.
        defaultEffort: "high",
        maxAttempts: 1,
        cooldownPolicy: "skip_pool_on_quota",
      },
    });
    gate = store.bots.find((b) => b.id === gate!.id)!;
    try {
      store.appendMessage?.(gate.threadId, {
        role: "bot",
        kind: "text",
        text: "我是 Gate：入口任务分类 Bot（轻量 Flash Low）。正式协作仍由 Momo / Judge / Workers 执行。",
      });
    } catch {
      /* ignore */
    }
    return gate;
  }

  // Keep identity + light model pinned on every boot.
  const needsPatch =
    gate.title !== GATE_TITLE ||
    gate.modelSelection?.model !== AI_GATE_MODEL_ID ||
    gate.modelSelection?.instanceId !== AI_GATE_PROVIDER ||
    gate.modelRouting?.enabled !== false ||
    gate.hidden === true;

  if (needsPatch) {
    store.patchBot(gate.id, {
      name: "Gate",
      title: GATE_TITLE,
      description: GATE_DESCRIPTION,
      hidden: false,
      pinned: true,
      chiefOfStaff: false,
      computer: "off",
      modelSelection: selection,
      modelRouting: {
        enabled: false,
        primary: {
          instanceId: selection.instanceId,
          model: selection.model,
          label: `Antigravity ${selection.model}`,
        },
        fallbacks: [],
        defaultEffort: "high",
        maxAttempts: 1,
        cooldownPolicy: "skip_pool_on_quota",
      },
    });
    gate = store.bots.find((b) => b.id === gate!.id)!;
  }

  return gate;
}

/** Resolve model id from Gate bot if present, else default light model. */
export function resolveGateModelId(bots: Array<{ name: string; modelSelection?: ModelSelection }>): string {
  const gate = bots.find((b) => isGateBotName(b.name));
  const model = gate?.modelSelection?.model?.trim();
  if (model && /flash-low|flash-medium/i.test(model)) return model;
  if (model && !/high$/i.test(model)) return model;
  return AI_GATE_MODEL_ID;
}
