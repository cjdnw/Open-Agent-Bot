import { describe, expect, it } from "vitest";
import {
  canTransition,
  hashArtifact,
  MAX_AUTO_REWORK,
  parseFinalReview,
  parseMomoPlan,
  parsePreReview,
  validateFinalBinding,
} from "./workflow.ts";

describe("workflow transitions", () => {
  it("allows the happy path", () => {
    expect(canTransition("CREATED", "PRE_REVIEW")).toBe(true);
    expect(canTransition("PRE_REVIEW", "PLANNING")).toBe(true);
    expect(canTransition("PLANNING", "EXECUTING")).toBe(true);
    expect(canTransition("EXECUTING", "FINAL_REVIEW")).toBe(true);
    expect(canTransition("FINAL_REVIEW", "COMPLETED")).toBe(true);
  });

  it("allows fail → rework → planning", () => {
    expect(canTransition("FINAL_REVIEW", "REWORK")).toBe(true);
    expect(canTransition("REWORK", "PLANNING")).toBe(true);
    expect(MAX_AUTO_REWORK).toBe(2);
  });

  it("rejects skipping pre-review", () => {
    expect(canTransition("CREATED", "EXECUTING")).toBe(false);
    expect(canTransition("PRE_REVIEW", "COMPLETED")).toBe(false);
  });
});

describe("parsePreReview", () => {
  it("parses SIMPLE without forcing COMPLEX", () => {
    const text = JSON.stringify({
      taskId: "t1",
      complexity: "SIMPLE",
      riskLevel: "LOW",
      reasoningRecommendation: "HIGH",
      difficultyReason: "one-file typo fix",
      recommendedRoles: [],
      acceptanceCriteria: ["file compiles"],
      requiredEvidence: ["diff"],
      riskWarnings: [],
      requiresUserAuthorization: false,
    });
    const pre = parsePreReview(text, "t1", false);
    expect(pre?.complexity).toBe("SIMPLE");
    expect(pre?.riskLevel).toBe("LOW");
    expect(pre?.reasoningEffective).toBe("HIGH");
  });

  it("downgrades XHIGH when capability is false", () => {
    const text = JSON.stringify({
      complexity: "MODERATE",
      riskLevel: "MEDIUM",
      reasoningRecommendation: "XHIGH",
      difficultyReason: "needs deep reasoning",
      acceptanceCriteria: ["tests pass"],
      requiresUserAuthorization: false,
    });
    const pre = parsePreReview(text, "t2", false);
    expect(pre?.reasoningRecommendation).toBe("XHIGH");
    expect(pre?.reasoningEffective).toBe("HIGH");
  });

  it("keeps HIGH risk separate from SIMPLE complexity", () => {
    const text = JSON.stringify({
      complexity: "SIMPLE",
      riskLevel: "HIGH",
      reasoningRecommendation: "HIGH",
      difficultyReason: "deletes production data",
      acceptanceCriteria: ["dry-run only"],
      requiresUserAuthorization: true,
    });
    const pre = parsePreReview(text, "t3", true);
    expect(pre?.complexity).toBe("SIMPLE");
    expect(pre?.riskLevel).toBe("HIGH");
    expect(pre?.requiresUserAuthorization).toBe(true);
  });
});

describe("parseMomoPlan + final review binding", () => {
  it("parses SELF/DELEGATE/ESCALATE", () => {
    expect(parseMomoPlan('```json\n{"decision":"SELF","reason":"easy"}\n```')?.decision).toBe("SELF");
    expect(parseMomoPlan('{"decision":"DELEGATE","reason":"x","delegateBotNames":["QA"]}')?.delegateBotNames).toEqual([
      "QA",
    ]);
    expect(parseMomoPlan('{"decision":"ESCALATE","reason":"need auth"}')?.decision).toBe("ESCALATE");
  });

  it("rejects PASS with mismatched artifact hash", async () => {
    const hash = await hashArtifact(["a", "b"]);
    const review = parseFinalReview(
      JSON.stringify({
        verdict: "PASS",
        reason: "ok",
        criteriaVersion: "crit-1",
        artifactHash: "deadbeef",
      }),
      "crit-1",
      hash,
    )!;
    const bound = validateFinalBinding(review, "crit-1", hash);
    expect(bound.verdict).toBe("BLOCKED");
  });

  it("accepts PASS with matching binding", async () => {
    const hash = await hashArtifact(["x"]);
    const review = parseFinalReview(
      JSON.stringify({
        verdict: "PASS",
        reason: "meets criteria",
        criteriaVersion: "crit-9",
        artifactHash: hash,
      }),
      "crit-9",
      hash,
    )!;
    expect(validateFinalBinding(review, "crit-9", hash).verdict).toBe("PASS");
  });
});
