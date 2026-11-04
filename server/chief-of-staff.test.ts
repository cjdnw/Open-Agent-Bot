import { describe, expect, it } from "vitest";
import {
  chiefSoloSystemPrompt,
  isCollaborationWorkflowEnabled,
} from "./chief-of-staff.ts";

describe("collaboration workflow switch", () => {
  it("defaults on for chief when field is unset", () => {
    expect(isCollaborationWorkflowEnabled({ chiefOfStaff: true })).toBe(true);
    expect(isCollaborationWorkflowEnabled({ chiefOfStaff: true, collaborationWorkflow: true })).toBe(true);
  });

  it("turns off only when chief explicitly disables it", () => {
    expect(isCollaborationWorkflowEnabled({ chiefOfStaff: true, collaborationWorkflow: false })).toBe(false);
  });

  it("stays off for non-chief bots", () => {
    expect(isCollaborationWorkflowEnabled({ chiefOfStaff: false, collaborationWorkflow: true })).toBe(false);
    expect(isCollaborationWorkflowEnabled({})).toBe(false);
  });

  it("solo prompt forbids delegation language", () => {
    const prompt = chiefSoloSystemPrompt();
    expect(prompt).toContain("关闭「协作流」");
    expect(prompt).toContain("不要委派");
  });
});
