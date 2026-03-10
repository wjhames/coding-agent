import { describe, expect, it } from "vitest";
import { buildExecutionContext } from "../../src/app/context-builder.js";

describe("buildExecutionContext", () => {
  it("uses compacted summaries and bounded sections in the prompt", () => {
    const context = buildExecutionContext({
      changedFiles: ["src/config.ts"],
      compaction: {
        changedFilesSummary: "Changed files: src/config.ts",
        eventSummary: "Recent event flow: tool_called -> tool_result_recorded",
        observationSummary: "Earlier observations: searched package.json | read config",
        verificationSummary: "pass:npm test"
      },
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
      memory: {
        artifacts: [],
        decisions: [
          {
            createdAt: "derived",
            evidence: ["npm test"],
            kind: "decision",
            relevance: "high",
            summary: "Verification passed: npm test"
          }
        ],
        working: [
          {
            createdAt: "derived",
            evidence: ["plan"],
            kind: "working",
            relevance: "high",
            summary: "Plan: Fix the config"
          }
        ]
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
      verificationCommands: ["npm test"]
    });

    expect(context).toContain("Compaction summary:");
    expect(context).toContain("Recent event flow: tool_called -> tool_result_recorded");
    expect(context).toContain("Memory:");
    expect(context).toContain("Snippet from src/config.ts:");
    expect(context.length).toBeLessThanOrEqual(16_000);
  });
});
