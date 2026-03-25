import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCliHarness,
  makeHomeDir,
  makeWorkspace,
  runBuiltCli
} from "../helpers/cli-harness.js";
import {
  cleanupMockLlmServers,
  createMockLlmServer,
  finalResponse,
  toolCallResponse
} from "../helpers/mock-llm.js";

const tempDirs: string[] = [];

describe("outside-in feature gaps", () => {
  afterEach(async () => {
    await cleanupMockLlmServers();
    await cleanupCliHarness();
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("reports an unknown command as usage guidance instead of falling into interactive mode", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");

    const run = await runBuiltCli(["exex"], homeDir);
    const combinedOutput = `${run.stdout}\n${run.stderr}`;

    expect(run.exitCode).toBe(1);
    expect(combinedOutput).toContain("Unknown command");
    expect(combinedOutput).toContain("coding-agent");
  });

  it("resumes the latest paused session instead of returning the latest completed session", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "printf 'paused' > paused.txt"
      }),
      finalResponse("Inspected the workspace."),
      finalResponse("Created paused.txt.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl);

    const paused = await runBuiltCli(
      ["exec", "Create paused.txt", "--json", "--cwd", workspace, "--approval-policy", "prompt"],
      homeDir
    );
    const pausedPayload = JSON.parse(paused.stdout) as {
      sessionId: string;
      status: string;
    };

    expect(pausedPayload.status).toBe("paused");

    const unrelated = await runBuiltCli(
      ["exec", "Inspect this workspace", "--json", "--cwd", workspace, "--approval-policy", "auto"],
      homeDir
    );
    const unrelatedPayload = JSON.parse(unrelated.stdout) as {
      sessionId: string;
      status: string;
    };

    expect(unrelatedPayload.status).toBe("completed");

    const resumed = await runBuiltCli(["resume", "--json", "--approval-policy", "auto"], homeDir);
    const resumedPayload = JSON.parse(resumed.stdout) as {
      changedFiles: string[];
      resumedFrom: string | null;
      status: string;
    };

    expect(resumed.exitCode).toBe(0);
    expect(resumedPayload.resumedFrom).toBe(pausedPayload.sessionId);
    expect(resumedPayload.resumedFrom).not.toBe(unrelatedPayload.sessionId);
    expect(resumedPayload.status).toBe("completed");
    expect(resumedPayload.changedFiles).toContain("paused.txt");
    await expect(readFile(join(workspace, "paused.txt"), "utf8")).resolves.toBe("paused");
  });

  it("keeps read-only inspection tasks from mutating the workspace", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: "unexpected\n",
            path: "unexpected.txt",
            type: "create"
          }
        ]
      }),
      finalResponse("Inspected the repository without making changes.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      [
        "exec",
        "Inspect this repository and summarize it without making changes.",
        "--json",
        "--cwd",
        workspace
      ],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      changedFiles: string[];
      status: string;
    };

    expect(run.exitCode).toBe(0);
    expect(payload.status).toBe("completed");
    expect(payload.changedFiles).toEqual([]);
    await expect(readFile(join(workspace, "unexpected.txt"), "utf8")).rejects.toThrow();
  });

  it("reruns verification after later edits so completion reflects the final workspace state", async () => {
    const workspace = await makeWorkspace({
      files: {
        "status.txt": "ready\n"
      },
      packageScripts: {
        test: "node -e \"const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'ready' ? 0 : 1)\""
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "npm test"
      }),
      toolCallResponse("apply_patch", {
        operations: [
          {
            newText: "broken\n",
            oldText: "ready\n",
            path: "status.txt",
            type: "replace"
          }
        ]
      }),
      finalResponse("Updated status.txt and verified it.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Change status.txt to broken and verify it", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      verification: {
        runs: Array<{ command: string; passed: boolean }>;
        status: string;
      };
    };

    expect(payload.status).toBe("failed");
    expect(payload.verification.status).toBe("failed");
    expect(payload.verification.runs.filter((runItem) => runItem.command === "npm test")).toHaveLength(2);
  });

  it("blocks shell commands that write outside the workspace even when they do not use redirection", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "coding-agent-outside-in-boundary-"));
    tempDirs.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".git"), { recursive: true });

    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "touch ../escape.txt"
      }),
      finalResponse("Created the file.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Create a file just outside the workspace", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
    };

    expect(payload.status).toBe("failed");
    await expect(readFile(join(root, "escape.txt"), "utf8")).rejects.toThrow();
  });

  it("blocks compound shell commands that start read-only but later write outside the workspace", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "coding-agent-outside-in-compound-"));
    tempDirs.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".git"), { recursive: true });

    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "pwd && touch ../escape.txt"
      }),
      finalResponse("Created the file.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "prompt");

    const run = await runBuiltCli(
      ["exec", "Create a file just outside the workspace", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
    };

    expect(payload.status).toBe("failed");
    expect(payload.summary).toContain("outside the workspace");
    await expect(readFile(join(root, "escape.txt"), "utf8")).rejects.toThrow();
  });

  it("surfaces approval-policy never as a first-class failed run with rejected approval details", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "printf 'blocked' > blocked.txt"
      }),
      finalResponse("I could not create blocked.txt because approval policy never does not allow shell side effects.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Create blocked.txt", "--json", "--cwd", workspace, "--approval-policy", "never"],
      homeDir
    );
    const payload = JSON.parse(run.stdout || run.stderr) as {
      approvals?: Array<{ status: string; tool: string }>;
      status?: string;
      summary?: string;
    };

    expect(run.exitCode).toBe(1);
    expect(payload.status).toBe("failed");
    expect(payload.approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "rejected",
          tool: "run_shell"
        })
      ])
    );
    expect((payload.summary ?? "").toLowerCase()).toContain("approval denied");
    await expect(readFile(join(workspace, "blocked.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps sessions listing usable when one saved session file is corrupt", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([finalResponse("Inspected the workspace.")]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(["exec", "Inspect this workspace", "--json", "--cwd", workspace], homeDir);
    const runPayload = JSON.parse(run.stdout) as {
      sessionId: string;
    };

    await writeFile(
      join(homeDir, ".coding-agent", "sessions", "corrupt.json"),
      "{ not-valid-json",
      "utf8"
    );

    const sessions = await runBuiltCli(["sessions", "--json"], homeDir);

    expect(sessions.exitCode).toBe(0);
    const payload = JSON.parse(sessions.stdout) as Array<{ id: string; status: string }>;
    expect(payload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: runPayload.sessionId,
          status: "completed"
        })
      ])
    );
  });

  it("writes doctor output to --output instead of stdout", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");
    const outputRoot = await mkdtemp(join(os.tmpdir(), "coding-agent-doctor-output-"));
    tempDirs.push(outputRoot);
    const outputPath = join(outputRoot, "doctor.json");

    const run = await runBuiltCli(["doctor", "--json", "--output", outputPath], homeDir);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    const written = JSON.parse(await readFile(outputPath, "utf8")) as {
      configPresent: boolean;
      llmReady: boolean;
    };
    expect(written).toMatchObject({
      configPresent: true,
      llmReady: true
    });
  });

  it("writes sessions output to --output instead of stdout", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([finalResponse("Inspected the workspace.")]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");
    const outputRoot = await mkdtemp(join(os.tmpdir(), "coding-agent-sessions-output-"));
    tempDirs.push(outputRoot);
    const outputPath = join(outputRoot, "sessions.json");

    await runBuiltCli(["exec", "Inspect this workspace", "--json", "--cwd", workspace], homeDir);

    const run = await runBuiltCli(["sessions", "--json", "--output", outputPath], homeDir);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    const written = JSON.parse(await readFile(outputPath, "utf8")) as Array<{ status: string }>;
    expect(written[0]?.status).toBe("completed");
  });

  it("enforces the exposed --timeout flag for shell execution", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "sleep 2"
      }),
      finalResponse("Finished.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Sleep briefly", "--json", "--cwd", workspace, "--timeout", "1ms"],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
    };

    expect(run.exitCode).toBe(1);
    expect(payload.status).toBe("failed");
    expect(payload.summary.toLowerCase()).toContain("timeout");
  });
});
