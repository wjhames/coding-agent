import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { continueTask, startTask } from "../../src/runtime/api.js";

const tempDirs: string[] = [];

describe("runtime context continuation", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("continues a session with canonical conversation history in the next request", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                content: "First answer."
              }
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                content: "Follow-up answer."
              }
            }
          ]
        })
      );

    const first = await startTask({
      environment: {
        fetchImpl,
        processCwd: cwd,
        sessionHomeDir: homeDir
      },
      observer: undefined,
      options: {},
      prompt: "Inspect package.json"
    });

    const second = await continueTask({
      environment: {
        fetchImpl,
        processCwd: cwd,
        sessionHomeDir: homeDir
      },
      observer: undefined,
      options: {},
      prompt: "Now explain the scripts",
      sessionId: first.sessionId ?? ""
    });

    expect(second?.sessionId).toBe(first.sessionId);
    expect(second?.turnCount).toBeGreaterThan(first.turnCount);

    const secondRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ content: string; role: string }>;
    };
    expect(secondRequest.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user"
    ]);
    expect(secondRequest.messages[1]?.content).toBe("Inspect package.json");
    expect(secondRequest.messages[2]?.content).toBe("First answer.");
    expect(secondRequest.messages[3]?.content).toBe("Now explain the scripts");
  });
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-runtime-context-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, "AGENTS.md"), "repo guidance\n", "utf8");
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\""
      }
    }),
    "utf8"
  );

  return cwd;
}

async function makeHomeDir(): Promise<string> {
  const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-runtime-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}

async function writeHomeConfig(homeDir: string): Promise<void> {
  const configDir = join(homeDir, ".coding-agent");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      defaultProfile: "local",
      profiles: {
        local: {
          apiKey: "secret",
          approvalPolicy: "prompt",
          baseUrl: "http://localhost:1234/v1",
          contextWindowTokens: 32_000,
          model: "gpt-4.1-mini"
        }
      }
    }),
    "utf8"
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
