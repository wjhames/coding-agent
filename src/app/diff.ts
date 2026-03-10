import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { Artifact } from "../cli/output.js";

export async function createDiffArtifact(args: {
  after: string | null;
  before: string | null;
  path: string;
}): Promise<Artifact> {
  const tempDir = await mkdtemp(join(os.tmpdir(), "coding-agent-diff-"));
  const beforePath = join(tempDir, "before.txt");
  const afterPath = join(tempDir, "after.txt");

  try {
    await writeFile(beforePath, args.before ?? "", "utf8");
    await writeFile(afterPath, args.after ?? "", "utf8");

    const diff = await runGitDiff({
      afterPath,
      beforePath,
      label: args.path
    });

    return {
      diff,
      kind: "diff",
      path: args.path
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

export async function readMaybeFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function runGitDiff(args: {
  afterPath: string;
  beforePath: string;
  label: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "diff",
        "--no-index",
        "--no-color",
        "--unified=3",
        "--text",
        args.beforePath,
        args.afterPath
      ],
      {
        cwd: dirname(args.beforePath)
      }
    );

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
      if (code === 0 || code === 1) {
        resolve(
          stdout
            .replace(/^diff --git .+$/m, `diff --git a/${args.label} b/${args.label}`)
            .replace(/^--- .+$/m, `--- a/${args.label}`)
            .replace(/^\+\+\+ .+$/m, `+++ b/${args.label}`)
            .trim()
        );
        return;
      }

      reject(new Error(stderr || "Failed to generate diff."));
    });
  });
}
