import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/main.js";

const tempDirs: string[] = [];

describe("runCli", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("exec writes a real json result and persists a session", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir);
    const io = createMemoryIo();
    const fetchImpl = mockCompletionFetch(
      "Plan ready.\nNext actions: inspect repo guidance and verify commands."
    );

    const exitCode = await runCli(
      ["exec", "inspect repo", "--json", "--cwd", cwd],
      io.streams,
      {
        fetchImpl,
        sessionHomeDir: homeDir
      }
    );

    expect(exitCode).toBe(0);
    const payload = JSON.parse(io.stdout);
    expect(payload.status).toBe("completed");
    expect(payload.sessionId).toEqual(expect.any(String));
    expect(payload.summary).toContain("Plan ready");
    expect(payload.plan).toEqual({
      summary: "Investigate the repository",
      items: [
        {
          id: "plan-1",
          content: "Inspect repo guidance",
          status: "in_progress"
        },
        {
          id: "plan-2",
          content: "Identify likely verification commands",
          status: "pending"
        }
      ]
    });
    expect(payload.nextActions).toEqual([
      "Inspect repo guidance",
      "Identify likely verification commands"
    ]);
    expect(payload.observations).toHaveLength(2);
    expect(payload.observations[0]).toEqual({
      excerpt: expect.stringContaining("package.json:1:"),
      query: "scripts",
      summary: "Found 1 match(es) for \"scripts\".",
      tool: "search_files"
    });
    expect(payload.observations[1]).toEqual({
      excerpt: expect.stringContaining("\"scripts\""),
      path: "package.json",
      summary: expect.stringContaining("Read package.json lines"),
      tool: "read_file"
    });
    expect(payload.repoContext).toEqual({
      guidanceFiles: ["AGENTS.md", "README.md", "package.json"],
      isGitRepo: true,
      topLevelEntries: [".git", "AGENTS.md", "README.md", "package.json"]
    });
    expect(payload.verification).toEqual({
      commands: ["npm run lint", "npm run typecheck", "npm test"],
      inferred: true,
      passed: false
    });
  });

  it("resume loads the latest session when no id is provided", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir);
    const io = createMemoryIo();
    const fetchImpl = mockCompletionFetch(
      "Plan ready.\nNext actions: inspect repo guidance and verify commands."
    );

    await runCli(["exec", "inspect repo", "--json", "--cwd", cwd], io.streams, {
      fetchImpl,
      sessionHomeDir: homeDir
    });

    const resumeIo = createMemoryIo();
    const exitCode = await runCli(["resume", "--json"], resumeIo.streams, {
      sessionHomeDir: homeDir
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(resumeIo.stdout);
    expect(payload.status).toBe("completed");
    expect(payload.resumedFrom).toEqual(payload.sessionId);
    expect(payload.plan.summary).toBe("Investigate the repository");
    expect(payload.observations).toHaveLength(2);
  });

  it("exec rejects a missing prompt", async () => {
    const io = createMemoryIo();

    const exitCode = await runCli(["exec", "--json"], io.streams);

    expect(exitCode).toBe(1);
    expect(JSON.parse(io.stderr)).toEqual({
      error: "usage_error",
      message: "`coding-agent exec` requires a prompt.",
      exitCode: 1
    });
  });

  it("returns a session_not_found error when resume cannot find a session", async () => {
    const io = createMemoryIo();
    const homeDir = await makeHomeDir();

    const exitCode = await runCli(["resume", "missing", "--json"], io.streams, {
      sessionHomeDir: homeDir
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(io.stderr)).toEqual({
      error: "session_not_found",
      message: "Session `missing` was not found.",
      exitCode: 1
    });
  });

  it("loads config from the target workspace for exec", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir);
    const io = createMemoryIo();
    const fetchImpl = mockCompletionFetch("Plan ready.");

    const exitCode = await runCli(
      ["exec", "inspect repo", "--json", "--cwd", cwd],
      io.streams,
      {
        fetchImpl,
        sessionHomeDir: homeDir
      }
    );

    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:1234/v1/chat/completions",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("returns a config error when the model is missing", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    const io = createMemoryIo();

    const exitCode = await runCli(
      ["exec", "inspect repo", "--json", "--cwd", cwd],
      io.streams,
      {
        sessionHomeDir: homeDir
      }
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(io.stderr)).toEqual({
      error: "config_error",
      message:
        "A model is required. Set it in `~/.coding-agent/config.json` or pass `--model`.",
      exitCode: 1
    });
  });
});

function createMemoryIo() {
  let stdout = "";
  let stderr = "";

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    streams: {
      stdout: new Writable({
        write(chunk, _encoding, callback) {
          stdout += String(chunk);
          callback();
        }
      }),
      stderr: new Writable({
        write(chunk, _encoding, callback) {
          stderr += String(chunk);
          callback();
        }
      })
    }
  };
}

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-workspace-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, "AGENTS.md"), "repo guidance\n", "utf8");
  await writeFile(join(cwd, "README.md"), "readme\n", "utf8");
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        lint: "eslint .",
        test: "vitest run",
        typecheck: "tsc -p tsconfig.json --noEmit"
      }
    }),
    "utf8"
  );

  return cwd;
}

async function makeHomeDir(): Promise<string> {
  const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-home-"));
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
          model: "gpt-4.1-mini"
        }
      }
    }),
    "utf8"
  );
}

function mockCompletionFetch(content: string) {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "write_plan",
                      arguments: JSON.stringify({
                        summary: "Investigate the repository",
                        items: [
                          {
                            content: "Inspect repo guidance",
                            status: "in_progress"
                          },
                          {
                            content: "Identify likely verification commands",
                            status: "pending"
                          }
                        ]
                      })
                    }
                  }
                ]
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
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-2",
                    type: "function",
                    function: {
                      name: "search_files",
                      arguments: JSON.stringify({
                        query: "scripts"
                      })
                    }
                  },
                  {
                    id: "call-3",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({
                        path: "package.json",
                        startLine: 1,
                        maxLines: 20
                      })
                    }
                  }
                ]
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
      )
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content
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
      )
    );
}
