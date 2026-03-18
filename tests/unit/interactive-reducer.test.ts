import { describe, expect, it } from "vitest";
import { emptyContextSnapshot, emptyGuidanceSummary } from "../../src/session/aggregate.js";
import { applyCommandResultToModel } from "../../src/interactive/reducer.js";
import { createInteractiveModel } from "../../src/interactive/state.js";
import type { CommandResult } from "../../src/runtime/contracts.js";

describe("interactive reducer", () => {
  it("shows a failed completion line even when verification had already passed", () => {
    const initial = createInteractiveModel({
      cwd: "/tmp/workspace",
      doctor: null,
      recentSessions: []
    });
    const result: CommandResult = {
      approvals: [],
      artifacts: [],
      changedFiles: [],
      context: emptyContextSnapshot(),
      exitCode: 1,
      guidance: emptyGuidanceSummary(),
      nextActions: ["Finish the frontend"],
      observations: [],
      pendingApproval: null,
      plan: {
        items: [
          {
            content: "Finish the frontend",
            id: "plan-1",
            status: "pending"
          }
        ],
        summary: "Build the requested app."
      },
      repoContext: {
        guidanceFiles: [],
        isGitRepo: true,
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        },
        topLevelEntries: ["package.json"]
      },
      resumeCommand: null,
      sessionId: "session-1",
      status: "failed",
      summary: "Task incomplete: frontend work remains.",
      turnCount: 3,
      verification: {
        commands: ["npm test"],
        inferred: true,
        notRunReason: null,
        passed: true,
        ran: true,
        runs: [
          {
            command: "npm test",
            exitCode: 0,
            passed: true,
            stderr: "",
            stdout: ""
          }
        ],
        selectedCommands: ["npm test"],
        skippedCommands: [],
        status: "passed"
      }
    };

    const next = applyCommandResultToModel(initial, result);
    const lines = next.blocks.flatMap((block) => block.lines);

    expect(next.runtimeStatus).toBe("failed");
    expect(lines).toContain("Run failed.");
    expect(lines).not.toContain("Completed. Verification passed.");
  });
});
