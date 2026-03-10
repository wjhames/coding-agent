#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const distCli = join(repoRoot, "dist", "cli", "main.js");
const scenario = process.argv[2] ?? "inspect";

if (!["inspect", "pause-resume", "inspect", "write"].includes(scenario)) {
  console.error(`Unknown scenario: ${scenario}`);
  process.exit(1);
}

const tempHome = await mkdtemp(join(os.tmpdir(), "coding-agent-smoke-home-"));
const agentHome = join(tempHome, ".coding-agent");
await mkdir(agentHome, { recursive: true });
await copyFile(join(os.homedir(), ".coding-agent", "config.json"), join(agentHome, "config.json"));

let workspace = repoRoot;

try {
  if (scenario === "write" || scenario === "pause-resume") {
    workspace = await makeWriteWorkspace();
  }

  const prompt =
    scenario === "inspect"
      ? "Inspect this repository and summarize the current implementation status without making changes. Prefer file tools over shell for inspection."
      : "Use only files in the current workspace. Change the greeting in greeting.js from hello to hi, keep it runnable, and rely on inferred verification commands.";

  const payload =
    scenario === "pause-resume"
      ? await runPauseResumeScenario({ agentHome, prompt, workspace })
      : await runExecScenario({
          agentHome,
          approvalPolicy: scenario === "inspect" ? "never" : "auto",
          maxSteps: scenario === "inspect" ? "8" : "16",
          prompt,
          workspace
        });
  await validateScenario(scenario, workspace, payload);
  console.log(JSON.stringify({
    scenario,
    sessionId: payload.sessionId,
    status: payload.status,
    summary: payload.summary,
    verification: payload.verification
  }, null, 2));
} finally {
  await rm(tempHome, { force: true, recursive: true });

  if ((scenario === "write" || scenario === "pause-resume") && workspace !== repoRoot) {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function makeWriteWorkspace() {
  const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-smoke-write-"));
  await mkdir(join(cwd, ".git"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "smoke-write-workspace",
      private: true,
      scripts: {
        test: "node greeting.js"
      }
    }, null, 2),
    "utf8"
  );
  await writeFile(
    join(cwd, "greeting.js"),
    "const message = \"hello\";\nconsole.log(message);\n",
    "utf8"
  );
  return cwd;
}

async function validateScenario(scenario, workspace, payload) {
  if (payload.status !== "completed") {
    throw new Error(`Expected completed status for ${scenario}, received ${payload.status}.`);
  }

  if (scenario === "inspect") {
    if (payload.changedFiles.length !== 0) {
      throw new Error("Inspect smoke should not change files.");
    }
    return;
  }

  if (!payload.changedFiles.includes("greeting.js")) {
    throw new Error("Write smoke did not report greeting.js as changed.");
  }

  if (payload.verification.status !== "passed") {
    throw new Error(`Write smoke expected verification to pass, received ${payload.verification.status}.`);
  }

  const contents = await readFile(join(workspace, "greeting.js"), "utf8");
  if (!contents.includes("\"hi\"")) {
    throw new Error("Write smoke did not update greeting.js to hi.");
  }
}

async function runExecScenario(args) {
  const result = await runNode(
    [
      distCli,
      "exec",
      args.prompt,
      "--json",
      "--cwd",
      args.workspace,
      "--max-steps",
      args.maxSteps,
      "--approval-policy",
      args.approvalPolicy
    ],
    {
      CODING_AGENT_HOME: args.agentHome
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(`Smoke scenario failed with exit code ${result.exitCode}.\n${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout);
}

async function runPauseResumeScenario(args) {
  const paused = await runNode(
    [
      distCli,
      "exec",
      args.prompt,
      "--json",
      "--cwd",
      args.workspace,
      "--max-steps",
      "16",
      "--approval-policy",
      "prompt"
    ],
    {
      CODING_AGENT_HOME: args.agentHome
    }
  );

  if (paused.exitCode !== 2) {
    throw new Error(`Pause-resume smoke expected paused exit code 2, received ${paused.exitCode}.`);
  }

  const pausedPayload = JSON.parse(paused.stdout);
  if (pausedPayload.status !== "paused" || !pausedPayload.sessionId) {
    throw new Error("Pause-resume smoke did not produce a paused session.");
  }

  const resumed = await runNode(
    [
      distCli,
      "resume",
      pausedPayload.sessionId,
      "--json",
      "--approval-policy",
      "auto"
    ],
    {
      CODING_AGENT_HOME: args.agentHome
    }
  );

  if (resumed.exitCode !== 0) {
    throw new Error(`Pause-resume smoke resume failed with exit code ${resumed.exitCode}.\n${resumed.stderr || resumed.stdout}`);
  }

  return JSON.parse(resumed.stdout);
}

function runNode(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env
      }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stderr,
        stdout
      });
    });
  });
}
