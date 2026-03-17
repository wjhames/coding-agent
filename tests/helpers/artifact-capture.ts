import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { FailureRecord } from "./failure-taxonomy.js";

export interface FailureArtifacts {
  failure: FailureRecord;
  files?: Record<string, string>;
  summary: string;
  transcript?: string;
}

const artifactDirs: string[] = [];

export async function captureFailureArtifacts(input: FailureArtifacts): Promise<string> {
  const root = await mkdir(join(os.tmpdir(), "coding-agent-test-artifacts"), {
    recursive: true
  }).then(() => join(os.tmpdir(), "coding-agent-test-artifacts"));
  const dir = join(root, `${Date.now()}-${input.failure.kind}`);
  artifactDirs.push(dir);
  await mkdir(dir, { recursive: true });

  const files = {
    "failure.json": JSON.stringify(input.failure, null, 2),
    "summary.txt": input.summary,
    ...(input.transcript ? { "transcript.txt": input.transcript } : {}),
    ...Object.fromEntries(
      Object.entries(input.files ?? {}).map(([name, contents]) => [name, contents])
    )
  };

  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(dir, name), contents, "utf8"))
  );

  return dir;
}

export async function cleanupFailureArtifacts(): Promise<void> {
  await Promise.all(
    artifactDirs.map(async (dir) => {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { force: true, recursive: true });
    })
  );
  artifactDirs.length = 0;
}
