import { describe, expect, it } from "vitest";
import { buildExecutionContext } from "../../src/app/context-builder.js";

describe("buildExecutionContext", () => {
  it("uses conversation summaries and bounded sections in the prompt", () => {
    const context = buildExecutionContext({
      changedFiles: ["src/config.ts"],
      cwd: "/workspace/project",
      guidance: {
        layers: [
          {
            content: "repo guidance",
            path: "AGENTS.md",
            priority: 240,
            rules: ["repo guidance"],
            source: "repo"
          },
          {
            content: "fix the config",
            path: "task",
            priority: 300,
            rules: ["fix the config"],
            source: "task"
          }
        ],
        summary: {
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
        }
      },
      observations: [
        {
          summary: "Read src/config.ts lines 1-20."
        }
      ],
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
      readOnlyTask: false,
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
      verificationCommands: ["npm test"]
    });

    expect(context).toContain("Conversation so far:");
    expect(context).toContain("Tool call read_file");
    expect(context).toContain("Tool result read_file");
    expect(context).toContain("Snippet from src/config.ts:");
    expect(context.length).toBeLessThanOrEqual(16_000);
  });
});
