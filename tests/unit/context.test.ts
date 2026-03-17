import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectContextSnippets,
  collectRepoContext,
  deriveWorkingSet
} from "../../src/app/context.js";

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

  it("prioritizes changed and explicitly named files in the working set", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "repo guidance\n", "utf8");

    const repoContext = await collectRepoContext(cwd);
    const workingSet = deriveWorkingSet({
      changedFiles: ["src/config.ts"],
      observations: [
        {
          excerpt: "1: export const value = 1;",
          path: "src/config.ts",
          summary: "Read src/config.ts lines 1-1.",
          tool: "read_file"
        }
      ],
      prompt: "fix src/config.ts and verify package.json scripts",
      repoContext,
      turns: [
        {
          at: "2026-03-16T12:00:00.000Z",
          id: "turn-1",
          kind: "user",
          text: "fix src/config.ts and verify package.json scripts"
        }
      ],
      verification: {
        commands: ["npm test"],
        inferred: true,
        notRunReason: "No file changes were made.",
        passed: false,
        ran: false,
        runs: [],
        selectedCommands: ["npm test"],
        skippedCommands: [],
        status: "not_run"
      }
    });

    expect(workingSet[0]?.path).toBe("src/config.ts");
    expect(workingSet.some((entry) => entry.path === "package.json")).toBe(true);
  });

  it("extracts relevant snippets from the working set", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src", "config.ts"),
      [
        "export const alpha = 1;",
        "export const configValue = 2;",
        "export function readConfig() {",
        "  return configValue;",
        "}"
      ].join("\n"),
      "utf8"
    );

    const snippets = await collectContextSnippets({
      cwd,
      prompt: "update configValue in src/config.ts",
      turns: [
        {
          at: "2026-03-16T12:00:00.000Z",
          id: "turn-1",
          kind: "user",
          text: "update configValue in src/config.ts"
        }
      ],
      workingSet: [
        {
          path: "src/config.ts",
          pinned: true,
          reason: "Changed in the current session.",
          score: 120,
          source: "changed"
        }
      ]
    });

    expect(snippets[0]?.path).toBe("src/config.ts");
    expect(snippets[0]?.excerpt).toContain("configValue");
    expect(snippets[0]?.startLine).toBeGreaterThanOrEqual(1);
  });
});
