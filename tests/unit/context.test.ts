import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("detects repo-native python verification signals and ignores placeholder npm tests", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-"));
    tempDirs.push(cwd);

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "mixed-workspace",
        private: true,
        scripts: {
          test: "echo \"Error: no test specified\" && exit 1"
        }
      }),
      "utf8"
    );
    await writeFile(
      join(cwd, "pyproject.toml"),
      [
        "[project]",
        'name = "mixed-workspace"',
        'dependencies = ["pytest", "ruff", "mypy"]'
      ].join("\n"),
      "utf8"
    );

    const repoContext = await collectRepoContext(cwd);

    expect(repoContext.packageScripts).toHaveProperty("test");
    expect(repoContext.verificationSignals).toEqual([
      expect.objectContaining({ command: "pytest", ecosystem: "python", kind: "test" }),
      expect.objectContaining({ command: "ruff check .", ecosystem: "python", kind: "lint" }),
      expect.objectContaining({ command: "mypy .", ecosystem: "python", kind: "typecheck" })
    ]);
    expect(
      repoContext.verificationSignals.some((signal) => signal.command === "npm test")
    ).toBe(false);
  });

  it("detects rust and go verification commands from top-level manifests", async () => {
    const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-context-"));
    tempDirs.push(cwd);

    await writeFile(
      join(cwd, "Cargo.toml"),
      ['[package]', 'name = "demo"', 'version = "0.1.0"'].join("\n"),
      "utf8"
    );
    await writeFile(join(cwd, "go.mod"), "module example.com/demo\n", "utf8");

    const repoContext = await collectRepoContext(cwd);

    expect(repoContext.verificationSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "cargo test", ecosystem: "rust" }),
        expect.objectContaining({ command: "go test ./...", ecosystem: "go" })
      ])
    );
  });
});
