import { describe, expect, it } from "vitest";
import {
  applyCommandResultToModel,
  applyRuntimeEventToModel,
  buildViewportLines,
  createInteractiveModel,
  enqueuePrompt,
  estimateContextLeftPercent,
  insertInteractiveLineBreak,
  reconcileViewportScroll,
  setInteractiveInput
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

    expect(lines[0]?.text.trim()).toBe("");
    expect(lines[1]?.text).toContain("Type a task");
    expect(lines.at(-1)?.text).toContain("gpt-4.1-mini");
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
    expect(queued.state.blocks.at(-1)?.queued).toBe(true);
  });

  it("shows a live working block while the agent is planning", () => {
    const model = applyRuntimeEventToModel(
      createInteractiveModel({
        cwd: "/workspace/project",
        doctor: null,
        recentSessions: []
      }),
      {
        at: "2026-03-10T10:00:00.000Z",
        status: "planning",
        type: "status"
      }
    );

    const lines = buildViewportLines({
      columns: 80,
      model,
      rows: 20
    }).map((line) => line.text);

    expect(lines.some((line) => line.includes("• Working"))).toBe(true);
    expect(lines.some((line) => line.includes("Thinking"))).toBe(true);
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
    expect(model.blocks[0]?.streaming).toBe(true);
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

  it("keeps the composer tight to the transcript", () => {
    let model = createInteractiveModel({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:00.000Z",
      text: "Line one\n\n\nLine two\n",
      type: "assistant_message"
    });

    const lines = buildViewportLines({
      columns: 80,
      model,
      rows: 20
    });
    const composerIndex = lines.findIndex((line) => line.text.includes("Type a task"));
    let blankRun = 0;
    for (let index = composerIndex - 1; index >= 0 && lines[index]?.text.trim() === ""; index -= 1) {
      blankRun += 1;
    }

    expect(composerIndex).toBeGreaterThan(0);
    expect(blankRun).toBeLessThanOrEqual(2);
  });

  it("bottom-aligns an active conversation at the live edge", () => {
    const queued = enqueuePrompt(
      createInteractiveModel({
        cwd: "/workspace/project",
        doctor: null,
        recentSessions: []
      }),
      "Walk me through this codebase"
    );
    let model = queued.state;

    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:00.000Z",
      text: Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join("\n"),
      type: "assistant_message"
    });

    const lines = buildViewportLines({
      columns: 80,
      model,
      rows: 20
    });
    const metadataIndex = lines.findIndex((line) => line.text.includes("/workspace/project"));

    expect(lines).toHaveLength(20);
    expect(lines.at(-1)?.text).toContain("/workspace/project");
    expect(metadataIndex).toBe(lines.length - 1);
  });

  it("does not bottom-align a short draft prompt", () => {
    const model = setInteractiveInput(
      createInteractiveModel({
        cwd: "/workspace/project",
        doctor: null,
        recentSessions: []
      }),
      "draft prompt"
    );
    const lines = buildViewportLines({
      columns: 80,
      model,
      rows: 20
    });

    expect(lines).toHaveLength(4);
    expect(lines[0]?.text.trim()).toBe("");
    expect(lines[1]?.text).toContain("draft prompt");
  });

  it("keeps the composer near the top while typing before submit", () => {
    const model = setInteractiveInput(
      createInteractiveModel({
        cwd: "/workspace/project",
        doctor: null,
        recentSessions: []
      }),
      "draft prompt"
    );

    const lines = buildViewportLines({
      columns: 80,
      model,
      rows: 20
    });

    expect(lines[0]?.text.trim()).toBe("");
    expect(lines[1]?.text).toContain("draft prompt");
    expect(lines.at(-1)?.text).toContain("/workspace/project");
  });

  it("supports multiline composer input", () => {
    const model = insertInteractiveLineBreak(
      setInteractiveInput(
        createInteractiveModel({
          cwd: "/workspace/project",
          doctor: null,
          recentSessions: []
        }),
        "first line"
      )
    );

    const lines = buildViewportLines({
      columns: 80,
      model,
      rows: 20
    });

    expect(lines[0]?.text.trim()).toBe("");
    expect(lines[1]?.text).toContain("first line");
    expect(lines[2]?.text.trim()).toBe("█");
  });

  it("renders approval blocks with explicit action details", () => {
    const model = applyRuntimeEventToModel(
      createInteractiveModel({
        cwd: "/workspace/project",
        doctor: null,
        recentSessions: []
      }),
      {
        approval: {
          actionClass: "shell_side_effect",
          command: "npm test",
          id: "approval-1",
          reason: "shell_side_effect",
          status: "pending",
          summary: "Approval required to run shell command: npm test",
          tool: "run_shell"
        },
        at: "2026-03-10T10:00:00.000Z",
        pendingAction: {
          action: {
            command: "npm test"
          },
          approval: {
            actionClass: "shell_side_effect",
            command: "npm test",
            id: "approval-1",
            reason: "shell_side_effect",
            status: "pending",
            summary: "Approval required to run shell command: npm test",
            tool: "run_shell"
          },
          tool: "run_shell"
        },
        type: "approval_requested"
      }
    );

    const lines = buildViewportLines({
      columns: 100,
      model,
      rows: 20
    }).map((line) => line.text);

    expect(lines.some((line) => line.includes("Approval needed"))).toBe(true);
    expect(lines.some((line) => line.includes("Tool: run_shell"))).toBe(true);
    expect(lines.some((line) => line.includes("Command: npm test"))).toBe(true);
  });

  it("renders verification failures with a summary and output excerpt", () => {
    const model = applyRuntimeEventToModel(
      createInteractiveModel({
        cwd: "/workspace/project",
        doctor: null,
        recentSessions: []
      }),
      {
        at: "2026-03-10T10:00:00.000Z",
        type: "verification_completed",
        verification: {
          commands: ["npm test"],
          inferred: true,
          notRunReason: null,
          passed: false,
          ran: true,
          runs: [
            {
              command: "npm test",
              exitCode: 1,
              passed: false,
              stderr: "Expected 1 to equal 2\nat test.ts:1",
              stdout: ""
            }
          ],
          selectedCommands: ["npm test"],
          skippedCommands: [],
          status: "failed"
        }
      }
    );

    const lines = buildViewportLines({
      columns: 100,
      model,
      rows: 20
    }).map((line) => line.text);

    expect(lines.some((line) => line.includes("Verification failed"))).toBe(true);
    expect(lines.some((line) => line.includes("[fail] npm test"))).toBe(true);
    expect(lines.some((line) => line.includes("Output: Expected 1 to equal 2"))).toBe(true);
  });

  it("preserves detached scroll while new lines stream in", () => {
    const current = applyRuntimeEventToModel(
      applyRuntimeEventToModel(
        createInteractiveModel({
          cwd: "/workspace/project",
          doctor: null,
          recentSessions: []
        }),
        {
          at: "2026-03-10T10:00:00.000Z",
          text: "First block\nSecond block\nThird block",
          type: "assistant_message"
        }
      ),
      {
        at: "2026-03-10T10:00:01.000Z",
        text: "Fourth block\nFifth block",
        type: "assistant_message"
      }
    );

    const detached = {
      ...current,
      scrollOffset: 6
    };
    const next = applyRuntimeEventToModel(detached, {
      at: "2026-03-10T10:00:02.000Z",
      delta: "\nSixth block",
      type: "assistant_delta"
    });
    const reconciled = reconcileViewportScroll(detached, next, 80);

    expect(reconciled.scrollOffset).toBeGreaterThan(detached.scrollOffset);
  });

  it("settles streamed assistant blocks when the turn completes", () => {
    let model = createInteractiveModel({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:00.000Z",
      delta: "## Heading\n- item",
      type: "assistant_delta"
    });
    model = applyCommandResultToModel(model, {
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
      sessionId: "session-1",
      status: "completed",
      summary: "",
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
    });

    expect(model.blocks.find((block) => block.kind === "assistant")?.streaming).toBe(false);
  });

  it("inserts separators when tool activity returns to assistant output", () => {
    let model = createInteractiveModel({
      cwd: "/workspace/project",
      doctor: null,
      recentSessions: []
    });

    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:00.000Z",
      text: "Thinking...",
      type: "assistant_message"
    });
    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:01.000Z",
      inputSummary: JSON.stringify({
        path: "/workspace/project/package.json"
      }),
      tool: "read_file",
      type: "tool_called"
    });
    model = applyRuntimeEventToModel(model, {
      at: "2026-03-10T10:00:02.000Z",
      text: "Finished reading.",
      type: "assistant_message"
    });

    const lines = buildViewportLines({
      columns: 100,
      model,
      rows: 20
    });

    expect(lines.some((line) => /^─{18,}$/.test(line.text))).toBe(true);
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
