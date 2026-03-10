import { describe, expect, it } from "vitest";
import {
  applyCommandResultToModel,
  applyRuntimeEventToModel,
  buildViewportLines,
  createInteractiveModel,
  enqueuePrompt,
  estimateContextLeftPercent
} from "../../src/interactive/model.js";

describe("interactive model", () => {
  it("starts with an inline composer and no transcript filler", () => {
    const model = createInteractiveModel({
      cwd: "/workspace/project",
      doctor: {
        configPresent: true,
        defaultProfile: "local",
        llmReady: true,
        model: "gpt-4.1-mini",
        profiles: ["local"],
        sessionHome: "/tmp/home"
      },
      recentSessions: []
    });

    const lines = buildViewportLines({
      columns: 100,
      model,
      rows: 12
    });

    expect(lines[0]?.text).toContain("Type a task");
    expect(lines[1]?.text).toContain("gpt-4.1-mini");
  });

  it("queues prompts while a run is active and marks the user block", () => {
    const base = createInteractiveModel({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });
    const running = applyRuntimeEventToModel(base, {
      at: "2026-03-10T10:00:00.000Z",
      status: "planning",
      type: "status"
    });

    const queued = enqueuePrompt(running, "follow up task");

    expect(queued.state.queuedPrompts).toHaveLength(1);
    expect(queued.state.blocks.at(-1)?.lines[0]).toContain("(queued)");
  });

  it("formats grouped exploration events without raw json", () => {
    let model = createInteractiveModel({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:00.000Z",
      inputSummary: JSON.stringify({
        path: "/workspace/project/src/interactive/app.ts",
        startLine: 1
      }),
      tool: "read_file",
      type: "tool_called"
    });
    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:01.000Z",
      inputSummary: JSON.stringify({
        path: "/workspace/project/src/runtime/api.ts"
      }),
      tool: "read_file",
      type: "tool_called"
    });

    expect(model.blocks).toHaveLength(1);
    expect(model.blocks[0]?.lines).toEqual([
      "Read src/interactive/app.ts",
      "Read src/runtime/api.ts"
    ]);
  });

  it("appends assistant deltas into a single live assistant block", () => {
    let model = createInteractiveModel({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:00.000Z",
      delta: "Hello ",
      type: "assistant_delta"
    });
    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:01.000Z",
      delta: "world",
      type: "assistant_delta"
    });

    expect(model.blocks).toHaveLength(1);
    expect(model.blocks[0]?.kind).toBe("assistant");
    expect(model.blocks[0]?.lines.join("\n")).toBe("Hello world");
  });

  it("keeps plan state when plan updates stream into the transcript", () => {
    const model = applyRuntimeEventToModel(
      createInteractiveModel({
        cwd: "/workspace/project",
        doctor: null,
        recentSessions: []
      }),
      {
        at: "2026-03-10T10:00:00.000Z",
        plan: {
          summary: "Inspect the repo",
          items: [
            {
              content: "Read package.json",
              id: "plan-1",
              status: "in_progress"
            }
          ]
        },
        type: "plan_updated"
      }
    );

    expect(model.plan?.summary).toBe("Inspect the repo");
    expect(model.blocks[0]?.lines[0]).toBe("Inspect the repo");
  });

  it("renders only a compact metadata line below the composer", () => {
    const model = applyCommandResultToModel(
      createInteractiveModel({
        cwd: "/workspace/project",
        doctor: {
          configPresent: true,
          defaultProfile: "local",
          llmReady: true,
          model: "gpt-4.1-mini",
          profiles: ["local"],
          sessionHome: "/tmp/home"
        },
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
        exitCode: 0,
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
        pendingApproval: null,
        plan: null,
        repoContext: {
          guidanceFiles: [],
          isGitRepo: true,
          topLevelEntries: []
        },
        resumeCommand: null,
        sessionId: "abc",
        status: "completed",
        summary: "Done.",
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

    const lines = buildViewportLines({
      columns: 100,
      model,
      rows: 20
    });
    const metadata = lines.at(-1)?.text ?? "";

    expect(metadata).toContain("gpt-4.1-mini");
    expect(metadata).toContain("% context left");
    expect(metadata).toContain("/workspace/project");
    expect(metadata).not.toContain("status:");
    expect(metadata).not.toContain("agent:");
  });

  it("estimates remaining context conservatively", () => {
    const model = createInteractiveModel({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    expect(estimateContextLeftPercent(model)).toBeGreaterThan(90);
  });
});
