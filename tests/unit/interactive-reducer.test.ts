import { describe, expect, it } from "vitest";
import { emptyContextSnapshot, emptyGuidanceSummary } from "../../src/session/aggregate.js";
import { applyCommandResultToModel, applyRuntimeEventToModel } from "../../src/interactive/reducer.js";
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

  it("rehydrates a pending approval block from a paused command result", () => {
    const initial = createInteractiveModel({
      cwd: "/tmp/workspace",
      doctor: null,
      recentSessions: []
    });
    const result: CommandResult = {
      approvals: [
        {
          actionClass: "shell_side_effect",
          command: "printf 'created' > created.txt",
          id: "approval-1",
          reason: "shell_side_effect",
          status: "pending",
          summary: "Approval required to run shell command",
          tool: "run_shell"
        }
      ],
      artifacts: [],
      changedFiles: [],
      context: emptyContextSnapshot(),
      exitCode: 2,
      guidance: emptyGuidanceSummary(),
      nextActions: [],
      observations: [],
      pendingApproval: {
        actionClass: "shell_side_effect",
        command: "printf 'created' > created.txt",
        reason: "shell_side_effect",
        summary: "Approval required to run shell command",
        tool: "run_shell"
      },
      plan: null,
      repoContext: {
        guidanceFiles: [],
        isGitRepo: true,
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        },
        topLevelEntries: ["package.json"]
      },
      resumeCommand: "coding-agent resume session-1 --approval-policy auto",
      sessionId: "session-1",
      status: "paused",
      summary: "Approval required to run shell command",
      turnCount: 2,
      verification: {
        commands: [],
        inferred: true,
        notRunReason: "Verification has not run yet.",
        passed: false,
        ran: false,
        runs: [],
        selectedCommands: [],
        skippedCommands: [],
        status: "not_run"
      }
    };

    const next = applyCommandResultToModel(initial, result);
    const approvalBlock = next.blocks.find((block) => block.kind === "approval");

    expect(next.runtimeStatus).toBe("paused");
    expect(next.pendingApproval).toEqual(result.pendingApproval);
    expect(approvalBlock).toBeDefined();
    expect(approvalBlock!.lines).toContain("Approval required to run shell command");
    expect(approvalBlock!.lines).toContain("Command: printf 'created' > created.txt");
  });

  it("records approval resolution feedback when the runtime emits approval_resolved", () => {
    const initial = createInteractiveModel({
      cwd: "/tmp/workspace",
      doctor: null,
      recentSessions: []
    });
    const paused = applyCommandResultToModel(initial, {
      approvals: [
        {
          actionClass: "shell_side_effect",
          command: "printf 'created' > created.txt",
          id: "approval-1",
          reason: "shell_side_effect",
          status: "pending",
          summary: "Approval required to run shell command",
          tool: "run_shell"
        }
      ],
      artifacts: [],
      changedFiles: [],
      context: emptyContextSnapshot(),
      exitCode: 2,
      guidance: emptyGuidanceSummary(),
      nextActions: [],
      observations: [],
      pendingApproval: {
        actionClass: "shell_side_effect",
        command: "printf 'created' > created.txt",
        reason: "shell_side_effect",
        summary: "Approval required to run shell command",
        tool: "run_shell"
      },
      plan: null,
      repoContext: {
        guidanceFiles: [],
        isGitRepo: true,
        packageScripts: {},
        topLevelEntries: ["package.json"]
      },
      resumeCommand: "coding-agent resume session-1 --approval-policy auto",
      sessionId: "session-1",
      status: "paused",
      summary: "Approval required to run shell command",
      turnCount: 2,
      verification: {
        commands: [],
        inferred: true,
        notRunReason: "Verification has not run yet.",
        passed: false,
        ran: false,
        runs: [],
        selectedCommands: [],
        skippedCommands: [],
        status: "not_run"
      }
    });

    const next = applyRuntimeEventToModel(paused, {
      approvalId: "approval-1",
      at: "2026-03-18T00:00:00.000Z",
      status: "approved",
      type: "approval_resolved"
    });
    const lines = next.blocks.flatMap((block) => block.lines);

    expect(next.pendingApproval).toBeNull();
    expect(lines).toContain("Approval approved.");
  });

  it("preserves the full streamed assistant response when the completion summary is shorter", () => {
    const initial = createInteractiveModel({
      cwd: "/tmp/workspace",
      doctor: null,
      recentSessions: []
    });
    const fullText = [
      "Here is the full answer.",
      "",
      "This second paragraph should stay visible after the run completes."
    ].join("\n");
    const streamed = applyRuntimeEventToModel(initial, {
      at: "2026-03-19T00:00:00.000Z",
      delta: fullText,
      type: "assistant_delta"
    });
    const withAssistantMessage = applyRuntimeEventToModel(streamed, {
      at: "2026-03-19T00:00:01.000Z",
      text: fullText,
      type: "assistant_message"
    });

    const next = applyCommandResultToModel(withAssistantMessage, {
      approvals: [],
      artifacts: [],
      changedFiles: [],
      context: emptyContextSnapshot(),
      exitCode: 0,
      guidance: emptyGuidanceSummary(),
      nextActions: [],
      observations: [],
      pendingApproval: null,
      plan: null,
      repoContext: {
        guidanceFiles: [],
        isGitRepo: true,
        packageScripts: {},
        topLevelEntries: ["package.json"]
      },
      resumeCommand: null,
      sessionId: "session-2",
      status: "completed",
      summary: `${fullText}\n\nVerification not run: Verification has not run yet.`,
      turnCount: 1,
      verification: {
        commands: [],
        inferred: true,
        notRunReason: "Verification has not run yet.",
        passed: false,
        ran: false,
        runs: [],
        selectedCommands: [],
        skippedCommands: [],
        status: "not_run"
      }
    });

    const assistantBlocks = next.blocks.filter((block) => block.kind === "assistant");
    const lines = next.blocks.flatMap((block) => block.lines);

    expect(assistantBlocks).toHaveLength(1);
    expect(assistantBlocks[0]?.lines.join("\n")).toBe(fullText);
    expect(lines).toContain("This second paragraph should stay visible after the run completes.");
    expect(lines).toContain("Completed.");
  });

  it("replaces a shorter streamed assistant block when the final summary extends it", () => {
    const initial = createInteractiveModel({
      cwd: "/tmp/workspace",
      doctor: null,
      recentSessions: []
    });
    const streamed = applyRuntimeEventToModel(initial, {
      at: "2026-03-19T00:00:00.000Z",
      delta: "Started answer",
      type: "assistant_delta"
    });

    const next = applyCommandResultToModel(streamed, {
      approvals: [],
      artifacts: [],
      changedFiles: [],
      context: emptyContextSnapshot(),
      exitCode: 0,
      guidance: emptyGuidanceSummary(),
      nextActions: [],
      observations: [],
      pendingApproval: null,
      plan: null,
      repoContext: {
        guidanceFiles: [],
        isGitRepo: true,
        packageScripts: {},
        topLevelEntries: ["package.json"]
      },
      resumeCommand: null,
      sessionId: "session-3",
      status: "completed",
      summary: "Started answer with the final wording.",
      turnCount: 1,
      verification: {
        commands: [],
        inferred: true,
        notRunReason: "Verification has not run yet.",
        passed: false,
        ran: false,
        runs: [],
        selectedCommands: [],
        skippedCommands: [],
        status: "not_run"
      }
    });

    const assistantBlocks = next.blocks.filter((block) => block.kind === "assistant");

    expect(assistantBlocks).toHaveLength(1);
    expect(assistantBlocks[0]?.lines.join("\n")).toBe("Started answer with the final wording.");
  });
});
