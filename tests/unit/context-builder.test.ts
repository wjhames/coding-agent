import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRequestContext } from "../../src/app/context-builder.js";

const tempDirs: string[] = [];

describe("buildRequestContext", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("builds provider messages, snippets, and budgeted context", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-builder-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "repo guidance\n", "utf8");
    await writeFile(join(cwd, "src", "config.ts"), "export const value = 1;\n", "utf8");

    const request = await buildRequestContext({
      changedFiles: ["src/config.ts"],
      config: {
        approvalPolicy: "prompt",
        baseUrl: "http://localhost:1234/v1",
        contextWindowTokens: 8_000,
        maxSteps: 8,
        model: "gpt-4.1-mini",
        networkEgress: false,
        profileName: "test",
        timeout: "60s"
      },
      cwd,
      guidance: {
        activeRules: ["fix the config", "repo guidance"],
        sources: [
          {
            path: "task",
            priority: 300,
            source: "task"
          },
          {
            path: "AGENTS.md",
            priority: 240,
            source: "repo"
          }
        ]
      },
      observations: [
        {
          excerpt: "1: export const value = 1;",
          path: "src/config.ts",
          summary: "Read src/config.ts lines 1-20.",
          tool: "read_file"
        }
      ],
      pendingApprovalSummary: null,
      plan: {
        summary: "Fix the config",
        items: [
          {
            id: "plan-1",
            content: "Update src/config.ts",
            status: "in_progress"
          }
        ]
      },
      prompt: "fix the config",
      repoContext: {
        guidanceFiles: ["AGENTS.md"],
        isGitRepo: true,
        packageScripts: {
          test: "npm test"
        },
        snippets: [
          {
            content: "export const value = 1;",
            path: "src/config.ts"
          }
        ],
        topLevelEntries: [".git", "AGENTS.md", "src"]
      },
      systemPrompt: "You are a CLI coding agent.",
      turns: [
        {
          at: "2026-03-16T12:00:00.000Z",
          id: "turn-1",
          kind: "user",
          text: "fix the config"
        },
        {
          at: "2026-03-16T12:00:01.000Z",
          id: "turn-2",
          inputSummary: "{\"path\":\"src/config.ts\"}",
          kind: "tool_call",
          tool: "read_file"
        },
        {
          at: "2026-03-16T12:00:02.000Z",
          changedFiles: [],
          error: null,
          id: "turn-3",
          kind: "tool_result",
          paths: ["src/config.ts"],
          summary: "Read src/config.ts lines 1-20.",
          tool: "read_file"
        }
      ],
      verification: {
        commands: ["npm test"],
        inferred: true,
        notRunReason: "No file changes were made.",
        passed: false,
        ran: false,
        runs: [],
        selectedCommands: ["npm test"],
        skippedCommands: [],
        status: "not_run"
      },
      verificationCommands: ["npm test"]
    });

    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[0]?.content).toContain("Active guidance:");
    expect(request.messages[0]?.content).toContain("Relevant code from");
    expect(request.messages.some((message) => message.role === "user")).toBe(true);
    expect(request.context.workingSet.some((entry) => entry.path === "src/config.ts")).toBe(true);
    expect(request.context.budget.inputTokens).toBeGreaterThan(0);
    expect(request.context.budget.contextWindowTokens).toBe(8_000);
  });
});
