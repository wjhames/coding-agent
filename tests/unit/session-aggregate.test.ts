import { describe, expect, it } from "vitest";
import { reduceSessionEvents } from "../../src/session/aggregate.js";
import {
  createApprovalRequestedEvent,
  createSessionCompletedEvent,
  createSessionStartedEvent,
  createToolResultRecordedEvent
} from "../../src/session/events.js";

describe("session aggregate", () => {
  it("requires session_started as the first event", () => {
    expect(() =>
      reduceSessionEvents([
        createSessionCompletedEvent({
          approvals: [],
          artifacts: [],
          changedFiles: [],
          pendingAction: null,
          summary: "done",
          verification: {
            commands: [],
            inferred: true,
            notRunReason: "No file changes were made.",
            passed: false,
            ran: false,
            runs: [],
            selectedCommands: [],
            skippedCommands: [],
            status: "not_run"
          }
        })
      ])
    ).toThrow("Session event log must start with session_started.");
  });

  it("deduplicates changed files and artifacts while reducing events", () => {
    const started = createSessionStartedEvent({
      config: {},
      cwd: "/workspace/project",
      guidance: {
        activeRules: [],
        sources: []
      },
      id: "session-1",
      mode: "exec",
      prompt: "inspect repo",
      repoContext: {
        guidanceFiles: [],
        isGitRepo: true,
        topLevelEntries: [".git"]
      }
    });
    const reduced = reduceSessionEvents([
      started,
      createToolResultRecordedEvent({
        artifacts: [
          { diff: "a", kind: "diff", path: "src/a.ts" },
          { diff: "b", kind: "diff", path: "src/a.ts" }
        ],
        changedFiles: ["src/b.ts", "src/a.ts", "src/b.ts"],
        tool: "apply_patch"
      })
    ]);

    expect(reduced?.artifacts).toEqual([{ diff: "b", kind: "diff", path: "src/a.ts" }]);
    expect(reduced?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("records pending approval details from approval_requested", () => {
    const started = createSessionStartedEvent({
      config: {},
      cwd: "/workspace/project",
      guidance: {
        activeRules: [],
        sources: []
      },
      id: "session-1",
      mode: "exec",
      prompt: "inspect repo",
      repoContext: {
        guidanceFiles: [],
        isGitRepo: true,
        topLevelEntries: [".git"]
      }
    });
    const approval = {
      actionClass: "shell_side_effect" as const,
      command: "npm test",
      id: "approval-1",
      reason: "shell_side_effect",
      status: "pending" as const,
      summary: "Approval required to run shell command: npm test",
      tool: "run_shell" as const
    };

    const reduced = reduceSessionEvents([
      started,
      createApprovalRequestedEvent({
        approval,
        pendingAction: {
          action: { command: "npm test" },
          approval,
          tool: "run_shell"
        }
      })
    ]);

    expect(reduced?.pendingAction?.tool).toBe("run_shell");
    expect(reduced?.approvals).toEqual([approval]);
  });
});
