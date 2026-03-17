import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
      packageScripts: {
        lint: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\"",
        typecheck: "node -e \"process.exit(0)\""
      },
      topLevelEntries: [".git", "AGENTS.md", "README.md", "package.json"]
    });
    expect(payload.guidance).toEqual({
      activeRules: [
        "inspect repo",
        "prefer concise summaries",
        "repo guidance",
        "readme"
      ],
      sources: [
        {
          path: "task",
          priority: 300,
          source: "task"
        },
        {
          path: "~/.coding-agent/AGENTS.md",
          priority: 260,
          source: "home"
        },
        {
          path: "AGENTS.md",
          priority: 240,
          source: "repo"
        },
        {
          path: "README.md",
          priority: 120,
          source: "repo"
        }
      ]
    });
    expect(payload.turnCount).toBeGreaterThanOrEqual(5);
    expect(payload.context.budget.contextWindowTokens).toBeNull();
    expect(payload.context.budget.inputTokens).toBeGreaterThan(0);
    expect(payload.context.recentTurnCount).toBeGreaterThan(0);
    expect(payload.context.snippets.some((snippet: { path: string }) => snippet.path === "package.json")).toBe(
      true
    );
    expect(
      payload.context.workingSet.some((entry: { path: string }) => entry.path === "AGENTS.md")
    ).toBe(true);
    expect(payload.verification).toEqual({
      commands: ["npm run lint", "npm run typecheck", "npm test"],
      inferred: true,
      notRunReason: "No file changes were made.",
      passed: false,
      ran: false,
      runs: [],
      selectedCommands: ["npm run lint", "npm run typecheck", "npm test"],
      skippedCommands: [
        {
          command: "npm run check",
          reason: "Script `check` is not defined."
        }
      ],
      status: "not_run"
    });
  });

  it("exec writes the settled assistant summary once in plain-text mode", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir);
    const io = createMemoryIo();
    const fetchImpl = mockCompletionFetch("Plan ready.");

    const exitCode = await runCli(
      ["exec", "inspect repo", "--cwd", cwd],
      io.streams,
      {
        fetchImpl,
        sessionHomeDir: homeDir
      }
    );

    expect(exitCode).toBe(0);
    expect(io.stdout).toContain("Plan ready.");
    expect(io.stdout.match(/Plan ready\./g)).toHaveLength(1);
    expect(io.stderr).toBe("");
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

  it("recovers from a tool error instead of failing the session", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir);
    await mkdir(join(cwd, ".notes"));
    const io = createMemoryIo();
    const fetchImpl = createSequenceFetch([
      toolResponse([
        {
          id: "call-1",
          name: "read_file",
          arguments: {
            path: ".notes"
          }
        }
      ]),
      finalResponse("Recovered after bad tool call and continued the task.")
    ]);

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
    expect(payload.summary).toContain("Recovered after bad tool call");
    expect(payload.observations).toContainEqual({
      excerpt: "Requested path is not a file: `.notes`.",
      summary: "Tool error from read_file: Requested path is not a file: `.notes`.",
      tool: "read_file"
    });
  });

  it("rejects interactive mode without a tty", async () => {
    const io = createMemoryIo();
    const exitCode = await runCli([], io.streams, {});

    expect(exitCode).toBe(1);
    expect(io.stdout).toContain("Interactive mode requires a TTY.");
  });

  it("rejects json mode for interactive runs", async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(["--json"], io.streams, {});

    expect(exitCode).toBe(1);
    expect(JSON.parse(io.stderr)).toEqual({
      error: "json_not_supported",
      message: "`--json` is only supported for non-interactive commands.",
      exitCode: 1
    });
  });

  it("pauses on apply_patch under prompt policy and resumes with auto approval", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir, { approvalPolicy: "prompt" });
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "config.ts"), "export const value = 1;\n", "utf8");
    const pauseIo = createMemoryIo();
    const fetchImpl = createSequenceFetch([
      toolResponse([
        {
          id: "call-1",
          name: "write_plan",
          arguments: {
            summary: "Fix config value",
            items: [
              {
                content: "Update src/config.ts",
                status: "in_progress"
              }
            ]
          }
        }
      ]),
      toolResponse([
        {
          id: "call-2",
          name: "apply_patch",
          arguments: {
            operations: [
              {
                type: "replace",
                path: "src/config.ts",
                oldText: "value = 1",
                newText: "value = 2"
              }
            ]
          }
        }
      ]),
      finalResponse("Patch applied and verification succeeded.")
    ]);

    const pauseExitCode = await runCli(
      ["exec", "fix config value", "--json", "--cwd", cwd],
      pauseIo.streams,
      {
        fetchImpl,
        sessionHomeDir: homeDir
      }
    );

    expect(pauseExitCode).toBe(2);
    const pausedPayload = JSON.parse(pauseIo.stdout);
    expect(pausedPayload.status).toBe("paused");
    expect(pausedPayload.approvals).toHaveLength(1);
    expect(pausedPayload.approvals[0].status).toBe("pending");
    expect(pausedPayload.pendingApproval).toEqual({
      actionClass: "patch_write",
      operationCount: 1,
      reason: "file_write",
      summary: "Approval required to apply 1 patch operation(s).",
      tool: "apply_patch"
    });
    expect(pausedPayload.resumeCommand).toContain("coding-agent resume");

    const resumeIo = createMemoryIo();
    const resumeExitCode = await runCli(
      ["resume", pausedPayload.sessionId, "--json", "--approval-policy", "auto"],
      resumeIo.streams,
      {
        fetchImpl,
        sessionHomeDir: homeDir
      }
    );

    expect(resumeExitCode).toBe(0);
    const resumedPayload = JSON.parse(resumeIo.stdout);
    expect(resumedPayload.status).toBe("completed");
    expect(resumedPayload.approvals[0].status).toBe("approved");
    expect(resumedPayload.changedFiles).toContain("src/config.ts");
    expect(resumedPayload.artifacts[0].path).toBe("src/config.ts");
    expect(resumedPayload.verification.passed).toBe(true);
    expect(resumedPayload.verification.ran).toBe(true);
    expect(resumedPayload.verification.selectedCommands).toEqual(["npm run lint", "npm run typecheck", "npm test"]);
    expect(resumedPayload.verification.status).toBe("passed");
    await expect(readFile(join(cwd, "src", "config.ts"), "utf8")).resolves.toContain(
      "value = 2"
    );
  });

  it("pauses on run_shell under prompt policy and resumes by executing the approved command", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir, { approvalPolicy: "prompt" });
    const pauseIo = createMemoryIo();
    const fetchImpl = createSequenceFetch([
      toolResponse([
        {
          id: "call-1",
          name: "run_shell",
          arguments: {
            command: "printf 'created' > created.txt"
          }
        }
      ]),
      finalResponse("Shell command completed.")
    ]);

    const pauseExitCode = await runCli(
      ["exec", "create a file", "--json", "--cwd", cwd],
      pauseIo.streams,
      {
        fetchImpl,
        sessionHomeDir: homeDir
      }
    );

    expect(pauseExitCode).toBe(2);
    const pausedPayload = JSON.parse(pauseIo.stdout);
    expect(pausedPayload.status).toBe("paused");
    expect(pausedPayload.pendingApproval).toEqual({
      actionClass: "shell_side_effect",
      command: "printf 'created' > created.txt",
      reason: "shell_side_effect",
      summary: "Approval required to run shell command: printf 'created' > created.txt",
      tool: "run_shell"
    });

    const resumeIo = createMemoryIo();
    const resumeExitCode = await runCli(
      ["resume", pausedPayload.sessionId, "--json", "--approval-policy", "auto"],
      resumeIo.streams,
      {
        fetchImpl,
        sessionHomeDir: homeDir
      }
    );

    expect(resumeExitCode).toBe(0);
    const resumedPayload = JSON.parse(resumeIo.stdout);
    expect(resumedPayload.status).toBe("completed");
    expect(resumedPayload.approvals[0].status).toBe("approved");
    expect(resumedPayload.changedFiles).toContain("created.txt");
    expect(resumedPayload.artifacts[0].path).toBe("created.txt");
    await expect(readFile(join(cwd, "created.txt"), "utf8")).resolves.toBe("created");
  });

  it("renders doctor output in json mode", async () => {
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir);
    const io = createMemoryIo();

    const exitCode = await runCli(["doctor", "--json"], io.streams, {
      sessionHomeDir: homeDir
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout)).toEqual({
      configPresent: true,
      defaultProfile: "local",
      llmReady: true,
      model: "gpt-4.1-mini",
      profiles: ["local"],
      sessionHome: homeDir
    });
  });

  it("lists recent sessions", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    await writeHomeConfig(homeDir);
    const io = createMemoryIo();
    const fetchImpl = mockCompletionFetch("Plan ready.");

    await runCli(["exec", "inspect repo", "--json", "--cwd", cwd], io.streams, {
      fetchImpl,
      sessionHomeDir: homeDir
    });

    const sessionsIo = createMemoryIo();
    const exitCode = await runCli(["sessions", "--json"], sessionsIo.streams, {
      sessionHomeDir: homeDir
    });

    expect(exitCode).toBe(0);
    const payload = JSON.parse(sessionsIo.stdout);
    expect(payload).toHaveLength(1);
    expect(payload[0].status).toBe("completed");
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
        lint: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\"",
        typecheck: "node -e \"process.exit(0)\""
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

async function writeHomeConfig(
  homeDir: string,
  overrides?: { approvalPolicy?: "auto" | "prompt" | "never" }
): Promise<void> {
  const configDir = join(homeDir, ".coding-agent");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      defaultProfile: "local",
      profiles: {
        local: {
          apiKey: "secret",
          approvalPolicy: overrides?.approvalPolicy ?? "prompt",
          baseUrl: "http://localhost:1234/v1",
          model: "gpt-4.1-mini"
        }
      }
    }),
    "utf8"
  );
  await writeFile(join(configDir, "AGENTS.md"), "prefer concise summaries\n", "utf8");
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

function toolResponse(
  calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>
) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments)
              }
            }))
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
}

function finalResponse(content: string) {
  return new Response(
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
  );
}

function createSequenceFetch(responses: Response[]) {
  return async () => {
    const next = responses.shift();

    if (!next) {
      throw new Error("No mocked responses remaining.");
    }

    return next;
  };
}
