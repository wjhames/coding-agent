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

if (!["inspect", "write"].includes(scenario)) {
  console.error(`Unknown scenario: ${scenario}`);
  process.exit(1);
}

const tempHome = await mkdtemp(join(os.tmpdir(), "coding-agent-smoke-home-"));
const agentHome = join(tempHome, ".coding-agent");
await mkdir(agentHome, { recursive: true });
await copyFile(join(os.homedir(), ".coding-agent", "config.json"), join(agentHome, "config.json"));

let workspace = repoRoot;

try {
  if (scenario === "write") {
    workspace = await makeWriteWorkspace();
  }

  const prompt =
    scenario === "inspect"
      ? "Inspect this repository and summarize the current implementation status without making changes. Prefer file tools over shell for inspection."
      : "Use only files in the current workspace. Change the greeting in greeting.js from hello to hi, keep it runnable, and rely on inferred verification commands.";

  const args = [
    distCli,
    "exec",
    prompt,
    "--json",
    "--cwd",
    workspace,
    "--max-steps",
    scenario === "inspect" ? "8" : "16",
    "--approval-policy",
    scenario === "inspect" ? "never" : "auto"
  ];
  const result = await runNode(args, {
    CODING_AGENT_HOME: agentHome
  });

  if (result.exitCode !== 0) {
    throw new Error(`Smoke scenario ${scenario} failed with exit code ${result.exitCode}.\n${result.stderr || result.stdout}`);
  }

  const payload = JSON.parse(result.stdout);
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

  if (scenario === "write" && workspace !== repoRoot) {
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
