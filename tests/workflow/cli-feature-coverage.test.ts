import { mkdtemp, readFile, rm } from "node:fs/promises";
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

describe("cli feature coverage", () => {
  afterEach(async () => {
    await cleanupMockLlmServers();
    await cleanupCliHarness();
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("shows root help with the supported commands and execution flags", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");

    const run = await runBuiltCli(["--help"], homeDir);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("coding-agent exec [prompt] [flags]");
    expect(run.stdout).toContain("coding-agent doctor [flags]");
    expect(run.stdout).toContain("--approval-policy <MODE>");
    expect(run.stderr).toBe("");
  });

  it("shows exec help with prompt usage and output/json flags", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");

    const run = await runBuiltCli(["exec", "--help"], homeDir);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("coding-agent exec [prompt] [flags]");
    expect(run.stdout).toContain("--json");
    expect(run.stdout).toContain("--output <FILE>");
    expect(run.stderr).toBe("");
  });

  it("reports interactive mode requires a TTY when started from a non-interactive process", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");

    const run = await runBuiltCli([], homeDir);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("Interactive mode requires a TTY.");
  });

  it("rejects --json for interactive mode", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");

    const run = await runBuiltCli(["--json"], homeDir);
    const payload = JSON.parse(run.stdout || run.stderr) as {
      error: string;
      message: string;
    };

    expect(run.exitCode).toBe(1);
    expect(payload.error).toBe("json_not_supported");
    expect(payload.message).toContain("only supported for non-interactive commands");
  });

  it("returns doctor json for a configured ready profile", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");

    const run = await runBuiltCli(["doctor", "--json"], homeDir);
    const payload = JSON.parse(run.stdout) as {
      configPresent: boolean;
      llmReady: boolean;
      model: string | null;
      profiles: string[];
    };

    expect(run.exitCode).toBe(0);
    expect(payload).toMatchObject({
      configPresent: true,
      llmReady: true,
      model: "test-model"
    });
    expect(payload.profiles).toEqual(["local"]);
  });

  it("returns doctor json for an unconfigured home directory", async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-empty-home-"));
    tempDirs.push(homeDir);

    const run = await runBuiltCli(["doctor", "--json"], homeDir);
    const payload = JSON.parse(run.stdout) as {
      configPresent: boolean;
      llmReady: boolean;
      model: string | null;
      profiles: string[];
    };

    expect(run.exitCode).toBe(0);
    expect(payload).toMatchObject({
      configPresent: false,
      llmReady: false,
      model: null
    });
    expect(payload.profiles).toEqual([]);
  });

  it("returns a usage error when exec is missing a prompt", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");

    const run = await runBuiltCli(["exec", "--json"], homeDir);
    const payload = JSON.parse(run.stdout || run.stderr) as {
      error: string;
      exitCode: number;
      message: string;
    };

    expect(run.exitCode).toBe(1);
    expect(payload).toMatchObject({
      error: "usage_error",
      exitCode: 1
    });
    expect(payload.message).toContain("requires a prompt");
  });

  it("prints the final summary in plain-text exec mode", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([finalResponse("Inspected the workspace.")]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(["exec", "Inspect this workspace", "--cwd", workspace], homeDir);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Inspected the workspace.");
    expect(run.stdout).toContain("Verification not run");
    expect(run.stderr).toBe("");
  });

  it("writes exec json output to the requested file", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([finalResponse("Inspected the workspace.")]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");
    const outputDir = await mkdtemp(join(os.tmpdir(), "coding-agent-exec-output-"));
    tempDirs.push(outputDir);
    const outputPath = join(outputDir, "result.json");

    const run = await runBuiltCli(
      ["exec", "Inspect this workspace", "--json", "--cwd", workspace, "--output", outputPath],
      homeDir
    );
    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      status: string;
      summary: string;
    };

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(payload.status).toBe("completed");
    expect(payload.summary).toContain("Inspected the workspace.");
  });

  it("writes exec errors to the requested file", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");
    const outputDir = await mkdtemp(join(os.tmpdir(), "coding-agent-exec-error-output-"));
    tempDirs.push(outputDir);
    const outputPath = join(outputDir, "error.json");

    const run = await runBuiltCli(["exec", "--json", "--output", outputPath], homeDir);
    const payload = JSON.parse(await readFile(outputPath, "utf8")) as {
      error: string;
      message: string;
    };

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(payload.error).toBe("usage_error");
    expect(payload.message).toContain("requires a prompt");
  });

  it("lists saved sessions after a completed exec run", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([finalResponse("Inspected the workspace.")]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const execRun = await runBuiltCli(["exec", "Inspect this workspace", "--json", "--cwd", workspace], homeDir);
    const execPayload = JSON.parse(execRun.stdout) as {
      sessionId: string;
    };

    const sessionsRun = await runBuiltCli(["sessions", "--json"], homeDir);
    const sessionsPayload = JSON.parse(sessionsRun.stdout) as Array<{ id: string; status: string }>;

    expect(sessionsRun.exitCode).toBe(0);
    expect(sessionsPayload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: execPayload.sessionId,
          status: "completed"
        })
      ])
    );
  });

  it("lists saved sessions in plain text mode", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([finalResponse("Inspected the workspace.")]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const execRun = await runBuiltCli(["exec", "Inspect this workspace", "--json", "--cwd", workspace], homeDir);
    const execPayload = JSON.parse(execRun.stdout) as {
      sessionId: string;
    };

    const sessionsRun = await runBuiltCli(["sessions"], homeDir);

    expect(sessionsRun.exitCode).toBe(0);
    expect(sessionsRun.stdout).toContain(execPayload.sessionId);
    expect(sessionsRun.stdout).toContain("completed");
  });

  it("returns a paused result with a resume command when approval is required", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "printf 'created' > created.txt"
      }),
      finalResponse("Created the file.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl);

    const run = await runBuiltCli(
      ["exec", "Create created.txt", "--json", "--cwd", workspace, "--approval-policy", "prompt"],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      pendingApproval: { command?: string; summary: string } | null;
      resumeCommand: string | null;
      status: string;
    };

    expect(run.exitCode).toBe(2);
    expect(payload.status).toBe("paused");
    expect(payload.pendingApproval?.summary).toContain("Approval required");
    expect(payload.pendingApproval?.command).toContain("created.txt");
    expect(payload.resumeCommand).toContain("coding-agent resume");
  });

  it("resumes a paused session by id and writes the resumed result to an output file", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "printf 'created' > created.txt"
      }),
      finalResponse("Created the file.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl);
    const outputDir = await mkdtemp(join(os.tmpdir(), "coding-agent-resume-output-"));
    tempDirs.push(outputDir);
    const outputPath = join(outputDir, "resume.json");

    const paused = await runBuiltCli(
      ["exec", "Create created.txt", "--json", "--cwd", workspace, "--approval-policy", "prompt"],
      homeDir
    );
    const pausedPayload = JSON.parse(paused.stdout) as {
      sessionId: string;
    };

    const resumed = await runBuiltCli(
      ["resume", pausedPayload.sessionId, "--json", "--approval-policy", "auto", "--output", outputPath],
      homeDir
    );
    const resumedPayload = JSON.parse(await readFile(outputPath, "utf8")) as {
      changedFiles: string[];
      resumedFrom: string;
      status: string;
    };

    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toBe("");
    expect(resumedPayload.status).toBe("completed");
    expect(resumedPayload.resumedFrom).toBe(pausedPayload.sessionId);
    expect(resumedPayload.changedFiles).toContain("created.txt");
  });

  it("returns a session-not-found error when resume is used with no saved sessions", async () => {
    const homeDir = await makeHomeDir("http://127.0.0.1:65535/v1", "auto");

    const run = await runBuiltCli(["resume", "--json"], homeDir);
    const payload = JSON.parse(run.stdout || run.stderr) as {
      error: string;
      message: string;
    };

    expect(run.exitCode).toBe(1);
    expect(payload.error).toBe("session_not_found");
    expect(payload.message).toContain("No saved sessions were found");
  });
});
