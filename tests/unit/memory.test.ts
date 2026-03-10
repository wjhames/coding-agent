import { describe, expect, it } from "vitest";
import { deriveMemory } from "../../src/app/memory.js";

describe("deriveMemory", () => {
  it("promotes plan, approvals, artifacts, and verification into structured memory", () => {
    const memory = deriveMemory({
      approvals: [
        {
          id: "approval-1",
          reason: "shell_side_effect",
          status: "approved",
          summary: "Run npm test",
          tool: "run_shell"
        }
      ],
      artifacts: [
        {
          diff: "diff --git a/src/config.ts b/src/config.ts",
          kind: "diff",
          path: "src/config.ts"
        }
      ],
      changedFiles: ["src/config.ts"],
      observations: [
        {
          excerpt: "1: export const value = 2;",
          path: "src/config.ts",
          summary: "Read src/config.ts lines 1-1.",
          tool: "read_file"
        }
      ],
      plan: {
        summary: "Fix the config value",
        items: [
          {
            id: "plan-1",
            content: "Update src/config.ts",
            status: "in_progress"
          }
        ]
      },
      verification: {
        commands: ["npm test"],
        inferred: true,
        passed: true,
        runs: [
          {
            command: "npm test",
            exitCode: 0,
            passed: true,
            stderr: "",
            stdout: "ok"
          }
        ]
      }
    });

    expect(memory.working.map((entry) => entry.summary)).toEqual([
      "Plan: Fix the config value",
      "Working set includes src/config.ts",
      "Read src/config.ts lines 1-1."
    ]);
    expect(memory.decisions.map((entry) => entry.summary)).toEqual([
      "Approval approved: Run npm test",
      "Verification passed: npm test"
    ]);
    expect(memory.artifacts.map((entry) => entry.summary)).toEqual([
      "Diff recorded for src/config.ts",
      "Changed file: src/config.ts"
    ]);
  });
});
