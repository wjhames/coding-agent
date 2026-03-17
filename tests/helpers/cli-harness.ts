import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const distCli = join(repoRoot, "dist", "cli", "main.js");

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();

export function trackHarnessChild(child: ChildProcess): void {
  children.add(child);
}

export async function cleanupCliHarness(): Promise<void> {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
  tempDirs.length = 0;
}

export async function makeWorkspace(input?: {
  files?: Record<string, string>;
  packageScripts?: Record<string, string>;
}): Promise<string> {
  const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-workflow-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, ".git"));
  if (input?.packageScripts) {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "workflow-test",
        private: true,
        scripts: input.packageScripts
      }),
      "utf8"
    );
  }

  for (const [path, contents] of Object.entries(input?.files ?? {})) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), contents, "utf8");
  }

  return cwd;
}

export async function makeHomeDir(baseUrl: string, approvalPolicy = "prompt"): Promise<string> {
  const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-workflow-home-"));
  tempDirs.push(homeDir);
  const agentHome = join(homeDir, ".coding-agent");
  await mkdir(agentHome, { recursive: true });
  await writeFile(
    join(agentHome, "config.json"),
    JSON.stringify({
      defaultProfile: "local",
      profiles: {
        local: {
          apiKey: "test-key",
          approvalPolicy,
          baseUrl,
          model: "test-model"
        }
      }
    }),
    "utf8"
  );
  return homeDir;
}

export async function runBuiltCli(args: string[], homeDir: string): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const child = spawn(process.execPath, [distCli, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODING_AGENT_HOME: join(homeDir, ".coding-agent")
    }
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const [exitCode] = (await once(child, "close")) as [number | null];
  children.delete(child);

  return {
    exitCode: exitCode ?? 1,
    stderr,
    stdout
  };
}

export async function snapshotWorkspace(cwd: string): Promise<Record<string, string>> {
  const listing = await listFilesRecursive(cwd);
  const entries = await Promise.all(
    listing.map(async (path) => [path, await readFile(join(cwd, path), "utf8")] as const)
  );
  return Object.fromEntries(entries);
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const output: string[] = [];

  async function walk(current: string, prefix = ""): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      output.push(relative);
    }
  }

  await walk(root);
  output.sort();
  return output;
}
