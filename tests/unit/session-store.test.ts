import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSession,
  loadSession,
  saveSession,
  SessionStoreError
} from "../../src/session/store.js";

const tempDirs: string[] = [];

describe("session store", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("rejects stale writes instead of overwriting newer session data", async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-session-store-"));
    tempDirs.push(homeDir);
    const session = await createSession(
      {
        config: {
          approvalPolicy: "auto",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "test-model"
        },
        cwd: "/tmp/workspace",
        mode: "exec",
        prompt: "Inspect the repo",
        repoContext: {
          guidanceFiles: [],
          isGitRepo: false,
          packageScripts: {},
          topLevelEntries: []
        },
        status: "paused",
        summary: "",
        turns: []
      },
      homeDir
    );

    const first = await loadSession(session.id, homeDir);
    const second = await loadSession(session.id, homeDir);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await saveSession(
      {
        ...first!,
        summary: "first",
        updatedAt: new Date(Date.parse(first!.updatedAt) + 1_000).toISOString()
      },
      homeDir,
      first!.updatedAt
    );

    await expect(
      saveSession(
        {
          ...second!,
          summary: "second"
        },
        homeDir,
        second!.updatedAt
      )
    ).rejects.toBeInstanceOf(SessionStoreError);

    await expect(loadSession(session.id, homeDir)).resolves.toMatchObject({
      summary: "first"
    });
  });
});
