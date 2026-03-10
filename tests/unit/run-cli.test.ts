import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
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
    const io = createMemoryIo();

    const exitCode = await runCli(
      ["exec", "inspect repo", "--json", "--cwd", cwd],
      io.streams,
      { sessionHomeDir: homeDir }
    );

    expect(exitCode).toBe(0);
    const payload = JSON.parse(io.stdout);
    expect(payload.status).toBe("completed");
    expect(payload.sessionId).toEqual(expect.any(String));
    expect(payload.summary).toContain("Prepared execution for prompt: inspect repo");
  });

  it("resume loads the latest session when no id is provided", async () => {
    const cwd = await makeWorkspace();
    const homeDir = await makeHomeDir();
    const io = createMemoryIo();

    await runCli(["exec", "inspect repo", "--json", "--cwd", cwd], io.streams, {
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
    const cwd = await makeWorkspace({
      config: {
        defaultProfile: "local",
        profiles: {
          local: {
            apiKeyEnv: "OPENAI_API_KEY",
            approvalPolicy: "prompt",
            baseUrl: "http://localhost:1234/v1",
            model: "gpt-4.1-mini"
          }
        }
      }
    });
    const homeDir = await makeHomeDir();
    const io = createMemoryIo();

    const exitCode = await runCli(
      ["exec", "inspect repo", "--json", "--cwd", cwd],
      io.streams,
      { sessionHomeDir: homeDir }
    );

    expect(exitCode).toBe(0);
    const payload = JSON.parse(io.stdout);
    expect(payload.summary).toContain("Guidance files: AGENTS.md, README.md.");
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

async function makeWorkspace(args?: { config?: unknown }): Promise<string> {
  const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-workspace-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, ".git"));
  await writeFile(join(cwd, "AGENTS.md"), "repo guidance\n", "utf8");
  await writeFile(join(cwd, "README.md"), "readme\n", "utf8");

  if (args?.config !== undefined) {
    await writeFile(join(cwd, ".coding-agent.json"), JSON.stringify(args.config), "utf8");
  }

  return cwd;
}

async function makeHomeDir(): Promise<string> {
  const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}
