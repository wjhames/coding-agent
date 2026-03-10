import { describe, expect, it } from "vitest";
import { applyCommandResult, applyRuntimeEvent, createInitialInteractiveState } from "../../src/interactive/state.js";

describe("interactive state", () => {
  it("starts with an empty transcript and compact input-first shell", () => {
    const state = createInitialInteractiveState({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    expect(state.transcript).toEqual([]);
    expect(state.footerMessage).toBeNull();
  });

  it("tracks runtime events into transcript and current plan", () => {
    let state = createInitialInteractiveState({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    state = applyRuntimeEvent(state, {
      at: "2026-03-10T10:00:00.000Z",
      detail: "Reading package.json",
      status: "reading",
      type: "status"
    });
    state = applyRuntimeEvent(state, {
      at: "2026-03-10T10:00:01.000Z",
      plan: {
        summary: "Inspect the repo",
        items: [
          {
            id: "plan-1",
            content: "Read package.json",
            status: "in_progress"
          }
        ]
      },
      type: "plan_updated"
    });

    expect(state.runtimeStatus).toBe("reading");
    expect(state.plan?.summary).toBe("Inspect the repo");
    expect(state.transcript.at(-1)?.kind).toBe("plan");
    expect(state.selectedTranscriptIndex).toBe(state.transcript.length - 1);
  });

  it("switches into approval mode from a paused result", () => {
    const state = applyCommandResult(
      createInitialInteractiveState({
        cwd: "/workspace/project",
        doctor: null,
        recentSessions: []
      }),
      {
        approvals: [],
        artifacts: [],
        changedFiles: [],
        compaction: {
          changedFilesSummary: null,
          eventSummary: null,
          observationSummary: null,
          verificationSummary: null
        },
        eventCount: 0,
        exitCode: 2,
        guidance: {
          activeRules: [],
          sources: []
        },
        lastEventAt: null,
        memory: {
          artifacts: [],
          decisions: [],
          working: []
        },
        nextActions: [],
        observations: [],
        pendingApproval: {
          actionClass: "patch_write",
          operationCount: 1,
          reason: "file_write",
          summary: "Approval required.",
          tool: "apply_patch"
        },
        plan: null,
        repoContext: {
          guidanceFiles: [],
          isGitRepo: true,
          topLevelEntries: []
        },
        resumeCommand: "coding-agent resume abc --approval-policy auto",
        sessionId: "abc",
        status: "paused",
        summary: "Approval required.",
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
      }
    );

    expect(state.mode).toBe("approval");
    expect(state.pendingApproval?.tool).toBe("apply_patch");
    expect(state.runtimeStatus).toBe("paused");
  });

  it("formats read-only tool events without raw json noise", () => {
    let state = createInitialInteractiveState({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    state = applyRuntimeEvent(state, {
      at: "2026-03-10T10:00:00.000Z",
      inputSummary: JSON.stringify({
        endLine: 80,
        path: "/workspace/project/src/interactive/app.ts",
        startLine: 1
      }),
      tool: "read_file",
      type: "tool_called"
    });
    state = applyRuntimeEvent(state, {
      at: "2026-03-10T10:00:01.000Z",
      observation: {
        excerpt: "export async function runInteractiveApp() {}",
        path: "/workspace/project/src/interactive/app.ts",
        summary: "Read src/interactive/app.ts lines 1-80.",
        tool: "read_file"
      },
      tool: "read_file",
      type: "tool_result"
    });

    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]?.body).toBe("Read src/interactive/app.ts");
  });
});
