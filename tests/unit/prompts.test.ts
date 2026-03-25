import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/execution/prompts.js";

describe("buildSystemPrompt", () => {
  it("instructs the model to create and maintain plans for multi-step work", () => {
    const prompt = buildSystemPrompt({
      config: {
        approvalPolicy: "auto"
      },
      readOnlyTask: false
    });

    expect(prompt).toContain(
      "For multi-step tasks, create a short plan with write_plan before making meaningful edits."
    );
    expect(prompt).toContain(
      "If a plan exists, work from the first unfinished item, keep exactly one item in_progress, and refresh the plan after meaningful progress."
    );
    expect(prompt).toContain(
      "Do not claim the task is complete until the current plan matches the work that was actually finished."
    );
  });
});
