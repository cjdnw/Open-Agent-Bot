import { describe, expect, it } from "vitest";
import {
  ensureGateBot,
  isGateBotName,
  isWorkflowInfrastructureBot,
  resolveGateModelId,
} from "./ensure-gate-bot.ts";
import { AI_GATE_MODEL_ID, AI_GATE_PROVIDER } from "./types.ts";

describe("ensureGateBot", () => {
  it("recognizes Gate / Judge as infrastructure", () => {
    expect(isGateBotName("Gate")).toBe(true);
    expect(isGateBotName("gate")).toBe(true);
    expect(isGateBotName("Developer")).toBe(false);
    expect(isWorkflowInfrastructureBot("Judge")).toBe(true);
    expect(isWorkflowInfrastructureBot("Gate")).toBe(true);
    expect(isWorkflowInfrastructureBot("QA")).toBe(false);
  });

  it("creates Gate with flash-low and routing disabled", () => {
    const bots: any[] = [];
    const store = {
      bots,
      createBot: () => {
        const b = {
          id: "gate-1",
          name: "New Bot",
          threadId: "th-gate",
          title: "",
          description: "",
          hidden: false,
          pinned: false,
          chiefOfStaff: false,
          collaborationWorkflow: false,
          computer: "off",
          autoApprove: false,
          alwaysAllow: [],
          modelSelection: { instanceId: "x", model: "y" },
          modelRouting: { enabled: true },
        };
        bots.push(b);
        return b;
      },
      patchBot: (id: string, patch: Record<string, unknown>) => {
        const b = bots.find((x) => x.id === id);
        if (!b) return null;
        Object.assign(b, patch);
        return b;
      },
    };
    const gate = ensureGateBot(store as any);
    expect(gate.name).toBe("Gate");
    expect(gate.modelSelection.instanceId).toBe(AI_GATE_PROVIDER);
    expect(gate.modelSelection.model).toBe(AI_GATE_MODEL_ID);
    expect(gate.modelRouting?.enabled).toBe(false);
    expect(gate.hidden).toBe(false);
  });

  it("coerces high model ids back to flash-low", () => {
    expect(
      resolveGateModelId([
        { name: "Gate", modelSelection: { instanceId: "antigravity", model: "gemini-3.8-flash-high" } },
      ]),
    ).toBe(AI_GATE_MODEL_ID);
    expect(
      resolveGateModelId([
        { name: "Gate", modelSelection: { instanceId: "antigravity", model: "gemini-3.8-flash-low" } },
      ]),
    ).toBe("gemini-3.8-flash-low");
  });
});
