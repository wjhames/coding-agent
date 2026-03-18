import { describe, expect, it } from "vitest";
import { planVerificationCommands } from "../../src/app/verification.js";

describe("planVerificationCommands", () => {
  it("does not infer verification for read-only inspection from incidental summary mentions", () => {
    expect(
      planVerificationCommands({
        assistantSummary: "This repository has build and test scripts and multiple tests under tests/ui.",
        changedFiles: [],
        packageScripts: {
          build: "node -e \"process.exit(0)\"",
          test: "node -e \"process.exit(0)\"",
          typecheck: "node -e \"process.exit(0)\""
        },
        prompt: "Inspect this repository and summarize the current implementation status without making changes."
      }).selectedCommands
    ).toEqual([]);
  });

  it("still selects verification commands when the user explicitly asks to verify", () => {
    expect(
      planVerificationCommands({
        assistantSummary: "",
        changedFiles: [],
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        },
        prompt: "Inspect the repo and run the tests to verify the current status."
      }).selectedCommands
    ).toEqual(["npm test"]);
  });
});
