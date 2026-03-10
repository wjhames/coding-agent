import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRepoContext } from "../../src/app/context.js";

const tempDirs: string[] = [];

describe("collectRepoContext", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("collects bounded repo context and package scripts", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, "AGENTS.md"), "repo guidance\n", "utf8");
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "eslint .",
          test: "vitest run",
          typecheck: "tsc -p tsconfig.json --noEmit"
        }
      }),
      "utf8"
    );

    const context = await collectRepoContext(cwd);

    expect(context.isGitRepo).toBe(true);
    expect(context.guidanceFiles).toEqual(["AGENTS.md", "package.json"]);
    expect(context.packageScripts).toEqual({
      lint: "eslint .",
      test: "vitest run",
      typecheck: "tsc -p tsconfig.json --noEmit"
    });
    expect(context.snippets.map((snippet) => snippet.path)).toEqual([
      "AGENTS.md",
      "package.json"
    ]);
  });

  it("ignores guidance entries that are directories", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, ".git"));
    await mkdir(join(cwd, "README.md"));

    const context = await collectRepoContext(cwd);

    expect(context.guidanceFiles).toEqual([]);
    expect(context.snippets).toEqual([]);
  });

  it("ignores guidance files that disappear before snippet reading", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-"));
    tempDirs.push(cwd);

    await mkdir(join(cwd, ".git"));
    await writeFile(join(cwd, "README.md"), "readme\n", "utf8");
    await unlink(join(cwd, "README.md"));

    const context = await collectRepoContext(cwd);

    expect(context.guidanceFiles).toEqual([]);
    expect(context.snippets).toEqual([]);
  });
});
