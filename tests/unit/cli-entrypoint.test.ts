import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEntrypointPath } from "../../src/cli/main.js";

const tempDirs: string[] = [];

describe("cli entrypoint", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("treats a symlinked binary path as the same entrypoint", async () => {
    const tempDir = await mkdtemp(join(os.tmpdir(), "coding-agent-entrypoint-"));
    tempDirs.push(tempDir);
    const realFile = join(tempDir, "real-main.js");
    const linkedFile = join(tempDir, "coding-agent");
    await writeFile(realFile, "#!/usr/bin/env node\n", "utf8");
    await symlink(realFile, linkedFile);

    expect(isEntrypointPath(linkedFile, new URL(`file://${realFile}`).href)).toBe(true);
  });

  it("returns false when the invoked path points at a different file", async () => {
    const tempDir = await mkdtemp(join(os.tmpdir(), "coding-agent-entrypoint-"));
    tempDirs.push(tempDir);
    const left = join(tempDir, "left.js");
    const right = join(tempDir, "right.js");
    await writeFile(left, "#!/usr/bin/env node\n", "utf8");
    await writeFile(right, "#!/usr/bin/env node\n", "utf8");

    expect(isEntrypointPath(left, new URL(`file://${right}`).href)).toBe(false);
  });
});
