import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  listRecentSessions,
  loadSession
} from "../../src/session/store.js";
import { getSessionEventsFilePath, getSessionFilePath } from "../../src/session/paths.js";

const tempDirs: string[] = [];

describe("session store", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("creates and loads a session record", async () => {
    const homeDir = await makeTempDir();
    const created = await createSession(
      {
        config: {
          approvalPolicy: "prompt"
        },
        cwd: "/workspace/project",
        mode: "exec",
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
        prompt: "fix the tests",
        repoContext: {
          guidanceFiles: ["AGENTS.md"],
          isGitRepo: true,
          topLevelEntries: [".git", "AGENTS.md", "package.json"]
        },
        status: "completed",
        summary: "Completed fix.",
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
          status: "passed"
        }
      },
      homeDir
    );

    const loaded = await loadSession(created.id, homeDir);

    expect(loaded).toEqual(created);
    expect(created.eventCount).toBeGreaterThan(0);
    expect(created.lastEventAt).toBeTruthy();
  });

  it("lists recent sessions in descending updated order", async () => {
    const homeDir = await makeTempDir();

    const first = await createSession(
      {
        config: {},
        cwd: "/workspace/one",
        mode: "exec",
        observations: [],
        repoContext: {
          guidanceFiles: [],
          isGitRepo: true,
          topLevelEntries: [".git"]
        },
        prompt: "first",
        status: "completed",
        summary: "first",
        verification: {
          commands: [],
          inferred: true,
          notRunReason: "No file changes were made.",
          passed: false,
          ran: false,
          runs: [],
          status: "not_run"
        }
      },
      homeDir
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await createSession(
      {
        config: {},
        cwd: "/workspace/two",
        mode: "exec",
        observations: [],
        repoContext: {
          guidanceFiles: [],
          isGitRepo: true,
          topLevelEntries: [".git"]
        },
        prompt: "second",
        status: "paused",
        summary: "second",
        verification: {
          commands: [],
          inferred: true,
          notRunReason: "No file changes were made.",
          passed: false,
          ran: false,
          runs: [],
          status: "not_run"
        }
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

  it("writes an append-only event log alongside the session snapshot", async () => {
    const homeDir = await makeTempDir();
    const created = await createSession(
      {
        config: {},
        cwd: "/workspace/project",
        mode: "exec",
        observations: [],
        prompt: "inspect repo",
        repoContext: {
          guidanceFiles: ["AGENTS.md"],
          isGitRepo: true,
          topLevelEntries: [".git", "AGENTS.md"]
        },
        status: "completed",
        summary: "done",
        verification: {
          commands: [],
          inferred: true,
          notRunReason: "No file changes were made.",
          passed: false,
          ran: false,
          runs: [],
          status: "not_run"
        }
      },
      homeDir
    );

    const rawEvents = await readFile(getSessionEventsFilePath(created.id, homeDir), "utf8");
    const events = rawEvents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });

    expect(events.map((event) => event.type)).toEqual([
      "session_started",
      "summary_updated",
      "session_completed"
    ]);
  });

  it("can rebuild a session from the event log when the snapshot is missing", async () => {
    const homeDir = await makeTempDir();
    const created = await createSession(
      {
        config: {
          approvalPolicy: "prompt"
        },
        cwd: "/workspace/project",
        mode: "exec",
        nextActions: ["Inspect repo"],
        observations: [],
        prompt: "inspect repo",
        repoContext: {
          guidanceFiles: ["AGENTS.md"],
          isGitRepo: true,
          topLevelEntries: [".git", "AGENTS.md"]
        },
        status: "paused",
        summary: "waiting for approval",
        verification: {
          commands: ["npm test"],
          inferred: true,
          notRunReason: "No file changes were made.",
          passed: false,
          ran: false,
          runs: [],
          status: "not_run"
        }
      },
      homeDir
    );

    await unlink(getSessionFilePath(created.id, homeDir));

    const loaded = await loadSession(created.id, homeDir);

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(created.id);
    expect(loaded?.status).toBe("paused");
    expect(loaded?.eventCount).toBe(3);
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "coding-agent-session-store-"));
  tempDirs.push(dir);
  return dir;
}
