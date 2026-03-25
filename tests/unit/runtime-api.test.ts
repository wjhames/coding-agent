import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTask } from "../../src/runtime/api.js";
import { listRecentSessions } from "../../src/session/store.js";
import type { ParsedOptions } from "../../src/cli/parse.js";

const tempDirs: string[] = [];

describe("runtime api", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("persists a running session before a non-interactive run finishes", async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-runtime-home-"));
    const workspace = await mkdtemp(join(os.tmpdir(), "coding-agent-runtime-workspace-"));
    tempDirs.push(homeDir, workspace);

    await mkdir(join(homeDir, ".coding-agent"), { recursive: true });
    await writeFile(
      join(homeDir, ".coding-agent", "config.json"),
      JSON.stringify({
        defaultProfile: "local",
        profiles: {
          local: {
            apiKey: "test-key",
            approvalPolicy: "auto",
            baseUrl: "http://127.0.0.1:1234/v1",
            model: "test-model"
          }
        }
      }),
      "utf8"
    );
    await mkdir(join(workspace, ".git"));

    const fetchImpl = vi.fn().mockImplementation(async () => {
      await delay(200);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Inspected the workspace."
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    const task = startTask({
      environment: {
        fetchImpl,
        processCwd: workspace,
        sessionHomeDir: homeDir
      },
      observer: undefined,
      options: createOptions(workspace),
      prompt: "Inspect this workspace"
    });

    const runningSession = await waitForRunningSession(homeDir);
    expect(runningSession?.status).toBe("running");
    expect(runningSession?.summary).toBe("Run in progress.");

    const result = await task;
    expect(result.status).toBe("completed");
  });
});

function createOptions(cwd: string): ParsedOptions {
  return {
    approvalPolicy: undefined,
    baseUrl: undefined,
    cwd,
    help: false,
    json: true,
    maxSteps: undefined,
    model: undefined,
    output: undefined,
    profile: undefined,
    quiet: false,
    timeout: undefined,
    verbose: false
  };
}

async function waitForRunningSession(homeDir: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const sessions = await listRecentSessions(5, homeDir);
    const running = sessions.find((session) => session.status === "running");
    if (running) {
      return running;
    }
    await delay(25);
  }

  throw new Error("Timed out waiting for a running session.");
}
