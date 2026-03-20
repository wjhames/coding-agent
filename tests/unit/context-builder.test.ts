import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRequestContext } from "../../src/app/context-builder.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { force: true, recursive: true })));
  tempDirs.length = 0;
});

describe("buildRequestContext", () => {
  it("reconstructs valid assistant tool_calls and tool responses from persisted turns", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-builder-"));
    tempDirs.push(cwd);

    const result = await buildRequestContext({
      changedFiles: [],
      config: {
        approvalPolicy: "auto"
      },
      cwd,
      guidance: {
        activeRules: [],
        sources: []
      },
      observations: [],
      pendingApprovalSummary: null,
      plan: null,
      prompt: "follow up",
      repoContext: {
        guidanceFiles: [],
        isGitRepo: false,
        packageScripts: {},
        topLevelEntries: []
      },
      systemPrompt: "system",
      turns: [
        {
          at: "2026-03-18T00:00:00.000Z",
          id: "user-1",
          kind: "user",
          text: "first prompt"
        },
        {
          at: "2026-03-18T00:00:01.000Z",
          id: "tool-call-1",
          inputSummary: "{\"path\":\"src/index.ts\"}",
          kind: "tool_call",
          tool: "read_file",
          toolCallId: "call-1"
        },
        {
          at: "2026-03-18T00:00:02.000Z",
          changedFiles: [],
          content: "{\"ok\":true,\"content\":\"hello\"}",
          error: null,
          id: "tool-result-1",
          kind: "tool_result",
          paths: ["src/index.ts"],
          summary: "Read src/index.ts",
          tool: "read_file",
          toolCallId: "call-1"
        },
        {
          at: "2026-03-18T00:00:03.000Z",
          id: "assistant-1",
          kind: "assistant",
          text: "Done reading."
        },
        {
          at: "2026-03-18T00:00:04.000Z",
          id: "user-2",
          kind: "user",
          text: "follow up"
        }
      ] as never,
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
      },
      verificationCommands: []
    });

    expect(result.messages.slice(1)).toEqual([
      {
        content: "first prompt",
        role: "user"
      },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              arguments: "{\"path\":\"src/index.ts\"}",
              name: "read_file"
            }
          }
        ]
      },
      {
        content: "{\"ok\":true,\"content\":\"hello\"}",
        role: "tool",
        tool_call_id: "call-1"
      },
      {
        content: "Done reading.",
        role: "assistant"
      },
      {
        content: "follow up",
        role: "user"
      }
    ]);
  });

  it("skips unreplayable legacy tool turns instead of emitting invalid bare tool messages", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-builder-"));
    tempDirs.push(cwd);

    const result = await buildRequestContext({
      changedFiles: [],
      config: {
        approvalPolicy: "auto"
      },
      cwd,
      guidance: {
        activeRules: [],
        sources: []
      },
      observations: [],
      pendingApprovalSummary: null,
      plan: null,
      prompt: "follow up",
      repoContext: {
        guidanceFiles: [],
        isGitRepo: false,
        packageScripts: {},
        topLevelEntries: []
      },
      systemPrompt: "system",
      turns: [
        {
          at: "2026-03-18T00:00:00.000Z",
          id: "user-1",
          kind: "user",
          text: "first prompt"
        },
        {
          at: "2026-03-18T00:00:01.000Z",
          id: "tool-call-1",
          inputSummary: "{\"path\":\"src/index.ts\"}",
          kind: "tool_call",
          tool: "read_file"
        },
        {
          at: "2026-03-18T00:00:02.000Z",
          changedFiles: [],
          error: null,
          id: "tool-result-1",
          kind: "tool_result",
          paths: ["src/index.ts"],
          summary: "Read src/index.ts",
          tool: "read_file"
        },
        {
          at: "2026-03-18T00:00:03.000Z",
          id: "assistant-1",
          kind: "assistant",
          text: "Done reading."
        },
        {
          at: "2026-03-18T00:00:04.000Z",
          id: "user-2",
          kind: "user",
          text: "follow up"
        }
      ] as never,
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
      },
      verificationCommands: []
    });

    expect(result.messages.slice(1)).toEqual([
      {
        content: "first prompt",
        role: "user"
      },
      {
        content: "Done reading.",
        role: "assistant"
      },
      {
        content: "follow up",
        role: "user"
      }
    ]);
  });

  it("keeps tool exchanges atomic when recent history is truncated by system notes", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-builder-"));
    tempDirs.push(cwd);

    const result = await buildRequestContext({
      changedFiles: ["spec.md"],
      config: {
        approvalPolicy: "auto"
      },
      cwd,
      guidance: {
        activeRules: [],
        sources: []
      },
      observations: [],
      pendingApprovalSummary: null,
      plan: null,
      prompt: "follow up",
      repoContext: {
        guidanceFiles: [],
        isGitRepo: false,
        packageScripts: {},
        topLevelEntries: ["spec.md"]
      },
      systemPrompt: "system",
      turns: [
        {
          at: "2026-03-19T00:48:59.000Z",
          id: "user-1",
          kind: "user",
          text: "Write a spec to spec.md"
        },
        {
          at: "2026-03-19T00:49:00.000Z",
          id: "tool-call-1",
          inputArguments: "{\"summary\":\"draft\"}",
          inputSummary: "{\"summary\":\"draft\"}",
          kind: "tool_call",
          tool: "write_plan",
          toolCallId: "call-1"
        },
        {
          at: "2026-03-19T00:49:01.000Z",
          changedFiles: [],
          content: "{\"ok\":true,\"plan\":1}",
          error: null,
          id: "tool-result-1",
          kind: "tool_result",
          paths: [],
          summary: "Wrote first plan.",
          tool: "write_plan",
          toolCallId: "call-1"
        },
        {
          at: "2026-03-19T00:49:02.000Z",
          id: "tool-call-2",
          inputArguments: "{\"summary\":\"refine\"}",
          inputSummary: "{\"summary\":\"refine\"}",
          kind: "tool_call",
          tool: "write_plan",
          toolCallId: "call-2"
        },
        {
          at: "2026-03-19T00:49:03.000Z",
          changedFiles: [],
          content: "{\"ok\":true,\"plan\":2}",
          error: null,
          id: "tool-result-2",
          kind: "tool_result",
          paths: [],
          summary: "Wrote second plan.",
          tool: "write_plan",
          toolCallId: "call-2"
        },
        {
          at: "2026-03-19T00:49:04.000Z",
          id: "tool-call-3",
          inputArguments: "{\"operations\":[{\"path\":\"spec.md\",\"type\":\"create\"}]}",
          inputSummary: "{\"operations\":[{\"path\":\"spec.md\",\"type\":\"create\"}]}",
          kind: "tool_call",
          tool: "apply_patch",
          toolCallId: "call-3"
        },
        {
          at: "2026-03-19T00:49:05.000Z",
          id: "system-1",
          kind: "system_note",
          text: "Approval required."
        },
        {
          at: "2026-03-19T00:49:06.000Z",
          id: "system-2",
          kind: "system_note",
          text: "Approval approved."
        },
        {
          at: "2026-03-19T00:49:07.000Z",
          changedFiles: ["spec.md"],
          content: "{\"ok\":true,\"changedFiles\":[\"spec.md\"]}",
          error: null,
          id: "tool-result-3",
          kind: "tool_result",
          paths: [],
          summary: "Applied patch.",
          tool: "apply_patch",
          toolCallId: "call-3"
        },
        {
          at: "2026-03-19T00:49:08.000Z",
          id: "system-3",
          kind: "system_note",
          text: "OpenAI-compatible request failed with status 400."
        }
      ] as never,
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
      },
      verificationCommands: []
    });

    expect(result.messages.slice(1)).toEqual([
      {
        content: "Write a spec to spec.md",
        role: "user"
      },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              arguments: "{\"summary\":\"draft\"}",
              name: "write_plan"
            }
          }
        ]
      },
      {
        content: "{\"ok\":true,\"plan\":1}",
        role: "tool",
        tool_call_id: "call-1"
      },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            id: "call-2",
            type: "function",
            function: {
              arguments: "{\"summary\":\"refine\"}",
              name: "write_plan"
            }
          }
        ]
      },
      {
        content: "{\"ok\":true,\"plan\":2}",
        role: "tool",
        tool_call_id: "call-2"
      },
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            id: "call-3",
            type: "function",
            function: {
              arguments: "{\"operations\":[{\"path\":\"spec.md\",\"type\":\"create\"}]}",
              name: "apply_patch"
            }
          }
        ]
      },
      {
        content: "{\"ok\":true,\"changedFiles\":[\"spec.md\"]}",
        role: "tool",
        tool_call_id: "call-3"
      }
    ]);
  });
});
