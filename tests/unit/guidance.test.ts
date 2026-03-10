import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGuidance } from "../../src/app/guidance.js";

const tempDirs: string[] = [];

describe("loadGuidance", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("merges task, home, and repo guidance in priority order", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-guidance-workspace-"));
    const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-guidance-home-"));
    tempDirs.push(cwd, homeDir);

    await writeFile(join(cwd, "AGENTS.md"), "repo rule\nshared rule\n", "utf8");
    await writeFile(join(cwd, "README.md"), "readme rule\n", "utf8");
    await mkdir(join(homeDir, ".coding-agent"), { recursive: true });
    await writeFile(
      join(homeDir, ".coding-agent", "AGENTS.md"),
      "home rule\nshared rule\n",
      "utf8"
    );

    const guidance = await loadGuidance({
      cwd,
      homeDir,
      prompt: "fix the failing test",
      repoGuidanceFiles: ["AGENTS.md", "README.md"]
    });

    expect(guidance.summary.activeRules).toEqual([
      "fix the failing test",
      "home rule",
      "shared rule",
      "repo rule",
      "readme rule"
    ]);
    expect(guidance.summary.sources).toEqual([
      {
        path: "task",
        priority: 300,
        source: "task"
      },
      {
        path: "~/.coding-agent/AGENTS.md",
        priority: 260,
        source: "home"
      },
      {
        path: "AGENTS.md",
        priority: 240,
        source: "repo"
      },
      {
        path: "README.md",
        priority: 120,
        source: "repo"
      }
    ]);
  });

  it("ignores repo guidance files that disappear before reading", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-guidance-workspace-"));
    const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-guidance-home-"));
    tempDirs.push(cwd, homeDir);

    const guidance = await loadGuidance({
      cwd,
      homeDir,
      prompt: "inspect repo",
      repoGuidanceFiles: ["README.md"]
    });

    expect(guidance.summary.activeRules).toEqual(["inspect repo"]);
    expect(guidance.summary.sources).toEqual([
      {
        path: "task",
        priority: 300,
        source: "task"
      }
    ]);
  });

  it("ignores repo guidance paths that are directories", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-guidance-workspace-"));
    const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-guidance-home-"));
    tempDirs.push(cwd, homeDir);
    await mkdir(join(cwd, "README.md"));

    const guidance = await loadGuidance({
      cwd,
      homeDir,
      prompt: "inspect repo",
      repoGuidanceFiles: ["README.md"]
    });

    expect(guidance.summary.activeRules).toEqual(["inspect repo"]);
    expect(guidance.summary.sources).toEqual([
      {
        path: "task",
        priority: 300,
        source: "task"
      }
    ]);
  });
});
