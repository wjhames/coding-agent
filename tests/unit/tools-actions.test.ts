import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalRequiredError } from "../../src/app/approval.js";
import { createApplyPatchTool } from "../../src/tools/apply-patch.js";
import { createRunShellTool } from "../../src/tools/run-shell.js";

const tempDirs: string[] = [];

describe("action tools", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("applies a patch and records a diff artifact", async () => {
    const cwd = await makeWorkspace();
    const approvals: unknown[] = [];
    const artifacts: unknown[] = [];
    const changedFiles: string[] = [];
    const observations: unknown[] = [];
    const tool = createApplyPatchTool({
      addApproval: (approval) => {
        approvals.push(approval);
      },
      addArtifacts: (nextArtifacts) => {
        artifacts.push(...nextArtifacts);
      },
      addChangedFiles: (files) => {
        changedFiles.push(...files);
      },
      addObservation: (observation) => {
        observations.push(observation);
      },
      config: {
        approvalPolicy: "auto",
        baseUrl: "http://localhost:1234/v1",
        maxSteps: 8,
        model: "gpt-4.1-mini",
        networkEgress: false,
        profileName: "local",
        timeout: undefined
      },
      cwd
    });

    await expect(
      tool.run({
        operations: [
          {
            type: "replace",
            path: "src/config.ts",
            oldText: "value = 1",
            newText: "value = 2"
          }
        ]
      })
    ).resolves.toContain("Applied patch");

    await expect(readFile(join(cwd, "src", "config.ts"), "utf8")).resolves.toContain(
      "value = 2"
    );
    expect(approvals).toHaveLength(0);
    expect(changedFiles).toEqual(["src/config.ts"]);
    expect(artifacts).toHaveLength(1);
    expect(observations).toHaveLength(1);
  });

  it("pauses shell side effects when approval policy is prompt", async () => {
    const cwd = await makeWorkspace();
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      config: {
        approvalPolicy: "prompt",
        baseUrl: "http://localhost:1234/v1",
        maxSteps: 8,
        model: "gpt-4.1-mini",
        networkEgress: false,
        profileName: "local",
        timeout: undefined
      },
      cwd,
      verificationCommands: []
    });

    await expect(
      tool.run({
        command: "printf 'hi' > created.txt"
      })
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-action-workspace-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "config.ts"), "export const value = 1;\n", "utf8");

  return cwd;
}
