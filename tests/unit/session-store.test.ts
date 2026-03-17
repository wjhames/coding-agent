import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  listRecentSessions,
  loadSession
} from "../../src/session/store.js";
import { getSessionFilePath } from "../../src/session/paths.js";

const tempDirs: string[] = [];

describe("session store", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("creates and loads a canonical session snapshot", async () => {
    const homeDir = await makeTempDir();
    const created = await createSession(
      {
        config: {
          approvalPolicy: "prompt"
        },
        context: {
          budget: {
            contextWindowTokens: 32_000,
            droppedSections: [],
            inputTokens: 1_024,
            outputReserveTokens: 2_048,
            remainingTokens: 28_928,
            sections: [
              {
                name: "recent-turns",
                tokens: 400
              }
            ],
            usedPercent: 10
          },
          historySummary: "Earlier discussion: inspect failing tests first.",
          recentTurnCount: 3,
          snippets: [
            {
              endLine: 20,
              excerpt: "1: import { test } from 'vitest';",
              path: "src/test.ts",
              reason: "recent read",
              startLine: 1
            }
          ],
          workingSet: [
            {
              path: "src/test.ts",
              pinned: true,
              reason: "changed file",
              score: 100,
              source: "changed"
            }
          ]
        },
        cwd: "/workspace/project",
        guidance: {
          activeRules: ["stay in workspace"],
          sources: []
        },
        mode: "exec",
        prompt: "fix the tests",
        repoContext: {
          guidanceFiles: ["AGENTS.md"],
          isGitRepo: true,
          packageScripts: {
            test: "npm test"
          },
          topLevelEntries: [".git", "AGENTS.md", "package.json"]
        },
        state: {
          changedFiles: ["src/test.ts"],
          nextActions: ["Run npm test"],
          observations: [
            {
              excerpt: "1: test line",
              path: "src/test.ts",
              summary: "Read src/test.ts lines 1-1.",
              tool: "read_file"
            }
          ],
          plan: {
            summary: "Fix the tests",
            items: [
              {
                id: "item-1",
                content: "Inspect failing tests",
                status: "in_progress"
              }
            ]
          },
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
                stdout: "ok"
              }
            ],
            selectedCommands: ["npm test"],
            skippedCommands: [],
            status: "passed"
          }
        },
        status: "completed",
        summary: "Completed fix.",
        turns: [
          {
            at: "2026-03-16T12:00:00.000Z",
            id: "turn-1",
            kind: "user",
            text: "fix the tests"
          },
          {
            at: "2026-03-16T12:00:01.000Z",
            id: "turn-2",
            kind: "assistant",
            text: "I inspected the tests and applied the fix."
          }
        ]
      },
      homeDir
    );

    const loaded = await loadSession(created.id, homeDir);

    expect(loaded).toEqual(created);
    expect(created.turns).toHaveLength(2);
    expect(created.context.workingSet[0]?.path).toBe("src/test.ts");
  });

  it("lists recent sessions in descending updated order", async () => {
    const homeDir = await makeTempDir();

    const first = await createSession(
      {
        config: {},
        cwd: "/workspace/one",
        mode: "exec",
        prompt: "first",
        repoContext: {
          guidanceFiles: [],
          isGitRepo: true,
          packageScripts: {},
          topLevelEntries: [".git"]
        },
        status: "completed",
        summary: "first"
      },
      homeDir
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await createSession(
      {
        config: {},
        cwd: "/workspace/two",
        mode: "exec",
        prompt: "second",
        repoContext: {
          guidanceFiles: [],
          isGitRepo: true,
          packageScripts: {},
          topLevelEntries: [".git"]
        },
        status: "paused",
        summary: "second"
      },
      homeDir
    );

    const sessions = await listRecentSessions(5, homeDir);

    expect(sessions.map((session) => session.id)).toEqual([second.id, first.id]);
  });

  it("returns an empty list when no sessions exist", async () => {
    const homeDir = await makeTempDir();

    await expect(listRecentSessions(5, homeDir)).resolves.toEqual([]);
  });

  it("writes a single canonical session snapshot file", async () => {
    const homeDir = await makeTempDir();
    const created = await createSession(
      {
        config: {},
        cwd: "/workspace/project",
        mode: "exec",
        prompt: "inspect repo",
        repoContext: {
          guidanceFiles: ["AGENTS.md"],
          isGitRepo: true,
          packageScripts: {},
          topLevelEntries: [".git", "AGENTS.md"]
        },
        status: "completed",
        summary: "done"
      },
      homeDir
    );

    const rawSnapshot = await readFile(getSessionFilePath(created.id, homeDir), "utf8");
    const snapshot = JSON.parse(rawSnapshot) as { id: string; turns: unknown[] };

    expect(snapshot.id).toBe(created.id);
    expect(Array.isArray(snapshot.turns)).toBe(true);
  });

  it("returns null when the snapshot is missing", async () => {
    const homeDir = await makeTempDir();
    const created = await createSession(
      {
        config: {
          approvalPolicy: "prompt"
        },
        cwd: "/workspace/project",
        mode: "exec",
        prompt: "inspect repo",
        repoContext: {
          guidanceFiles: ["AGENTS.md"],
          isGitRepo: true,
          packageScripts: {},
          topLevelEntries: [".git", "AGENTS.md"]
        },
        status: "paused",
        summary: "waiting for approval"
      },
      homeDir
    );

    await unlink(getSessionFilePath(created.id, homeDir));

    const loaded = await loadSession(created.id, homeDir);

    expect(loaded).toBeNull();
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "coding-agent-session-store-"));
  tempDirs.push(dir);
  return dir;
}
