import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createListFilesTool } from "../../src/tools/list-files.js";
import { createReadFileTool } from "../../src/tools/read-file.js";
import { createSearchFilesTool } from "../../src/tools/search-files.js";

const tempDirs: string[] = [];

describe("read-only tools", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("lists workspace files with bounded output", async () => {
    const cwd = await makeWorkspace();
    const observations: unknown[] = [];
    const tool = createListFilesTool({
      cwd,
      observe: (observation) => {
        observations.push(observation);
      }
    });

    await expect(tool.run({ limit: 10 })).resolves.toContain("src/config.ts");
    expect(observations).toHaveLength(1);
  });

  it("lists a single file when given a file path", async () => {
    const cwd = await makeWorkspace();
    const tool = createListFilesTool({
      cwd,
      observe: () => {}
    });

    await expect(
      tool.run({
        path: "src/config.ts"
      })
    ).resolves.toBe("src/config.ts");
  });

  it("reads a file with line numbers", async () => {
    const cwd = await makeWorkspace();
    const observations: unknown[] = [];
    const tool = createReadFileTool({
      cwd,
      observe: (observation) => {
        observations.push(observation);
      }
    });

    await expect(
      tool.run({
        path: "src/config.ts",
        startLine: 1,
        maxLines: 2
      })
    ).resolves.toContain("1: export const value = 1;");
    expect(observations).toHaveLength(1);
  });

  it("searches files for literal matches", async () => {
    const cwd = await makeWorkspace();
    const observations: unknown[] = [];
    const tool = createSearchFilesTool({
      cwd,
      observe: (observation) => {
        observations.push(observation);
      }
    });

    await expect(
      tool.run({
        query: "value = 1"
      })
    ).resolves.toContain("src/config.ts:1:");
    expect(observations).toHaveLength(1);
  });

  it("searches a single file when given a file path", async () => {
    const cwd = await makeWorkspace();
    const tool = createSearchFilesTool({
      cwd,
      observe: () => {}
    });

    await expect(
      tool.run({
        path: "src/config.ts",
        query: "value = 1"
      })
    ).resolves.toContain("src/config.ts:1:");
  });

  it("returns a normal error when asked to read a directory", async () => {
    const cwd = await makeWorkspace();
    const tool = createReadFileTool({
      cwd,
      observe: () => {}
    });

    await expect(
      tool.run({
        path: "src"
      })
    ).rejects.toThrow("Requested path is not a file: `src`.");
  });

  it("returns a normal error when asked to read a missing file", async () => {
    const cwd = await makeWorkspace();
    const tool = createReadFileTool({
      cwd,
      observe: () => {}
    });

    await expect(
      tool.run({
        path: "README.missing"
      })
    ).rejects.toThrow("Requested path was not found: `README.missing`.");
  });

  it("returns a normal error when listing a missing path", async () => {
    const cwd = await makeWorkspace();
    const tool = createListFilesTool({
      cwd,
      observe: () => {}
    });

    await expect(
      tool.run({
        path: "missing-dir"
      })
    ).rejects.toThrow("Requested path was not found: `missing-dir`.");
  });
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-tool-workspace-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "config.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(cwd, "README.md"), "config docs\n", "utf8");

  return cwd;
}
