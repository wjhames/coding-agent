import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  listRecentSessions,
  loadSession
} from "../../src/session/store.js";

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
        prompt: "fix the tests",
        status: "completed",
        summary: "Completed fix.",
        verification: {
          commands: ["npm test"],
          passed: true
        }
      },
      homeDir
    );

    const loaded = await loadSession(created.id, homeDir);

    expect(loaded).toEqual(created);
  });

  it("lists recent sessions in descending updated order", async () => {
    const homeDir = await makeTempDir();

    const first = await createSession(
      {
        config: {},
        cwd: "/workspace/one",
        mode: "exec",
        prompt: "first",
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
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "coding-agent-session-store-"));
  tempDirs.push(dir);
  return dir;
}
