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
});
