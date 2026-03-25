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
    ).resolves.toContain("\"operationCount\":1");

    await expect(readFile(join(cwd, "src", "config.ts"), "utf8")).resolves.toContain(
      "value = 2"
    );
    expect(approvals).toHaveLength(0);
    expect(changedFiles).toEqual(["src/config.ts"]);
    expect(artifacts).toHaveLength(1);
    expect(observations).toHaveLength(1);
  });

  it("normalizes absolute patch paths back to workspace-relative paths", async () => {
    const cwd = await makeWorkspace();
    const artifacts: Array<{ path: string }> = [];
    const changedFiles: string[] = [];
    const tool = createApplyPatchTool({
      addApproval: () => undefined,
      addArtifacts: (nextArtifacts) => {
        artifacts.push(...nextArtifacts);
      },
      addChangedFiles: (files) => {
        changedFiles.push(...files);
      },
      addObservation: () => undefined,
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

    await tool.run({
      operations: [
        {
          type: "replace",
          path: join(cwd, "src", "config.ts"),
          oldText: "value = 1",
          newText: "value = 2"
        }
      ]
    });

    expect(changedFiles).toEqual(["src/config.ts"]);
    expect(artifacts[0]?.path).toBe("src/config.ts");
  });

  it("pauses shell side effects when approval policy is prompt", async () => {
    const cwd = await makeWorkspace();
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
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

  it("allows read-only shell inspection with wrappers under prompt policy", async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "node -e \"process.exit(0)\""
        }
      }),
      "utf8"
    );
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
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
      verificationCommands: ["npm run typecheck"]
    });

    await expect(
      tool.run({
        command: `cd ${cwd} && ls -la src 2>&1 | head -20`
      })
    ).resolves.toContain("config.ts");

    await expect(
      tool.run({
        command: `cd ${cwd} && npm run typecheck 2>&1 | head -20`
      })
    ).resolves.toContain("\"exitCode\":0");
  });

  it("keeps approval required for compound commands that start with read-only segments", async () => {
    const cwd = await makeWorkspace();
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
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

    await expect(tool.run({ command: "pwd && touch created.txt" })).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    await expect(tool.run({ command: "ls && mkdir nested" })).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    await expect(tool.run({ command: "cat missing || touch rescue.txt" })).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );

    await expect(readFile(join(cwd, "created.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(cwd, "rescue.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps approval required for side-effecting commands that merely start with a verification command", async () => {
    const cwd = await makeWorkspace();
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"process.exit(0)\""
        }
      }),
      "utf8"
    );
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
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
      verificationCommands: ["npm test"]
    });

    await expect(
      tool.run({
        command: "npm test && printf 'created' > created.txt"
      })
    ).rejects.toBeInstanceOf(ApprovalRequiredError);

    await expect(readFile(join(cwd, "created.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps approval required for verification commands that add a writer in a later pipe segment", async () => {
    const cwd = await makeWorkspace();
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
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
      verificationCommands: ["npm test"]
    });

    await expect(
      tool.run({
        command: "npm test | tee verification.log"
      })
    ).rejects.toBeInstanceOf(ApprovalRequiredError);

    await expect(readFile(join(cwd, "verification.log"), "utf8")).rejects.toThrow();
  });

  it("rejects shell commands that write outside the workspace", async () => {
    const cwd = await makeWorkspace();
    const outsideDir = await mkdtemp(join(os.tmpdir(), "coding-agent-action-outside-"));
    tempDirs.push(outsideDir);
    const outsidePath = join(outsideDir, "escape.txt");
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
      config: {
        approvalPolicy: "auto",
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
        command: `printf 'escaped' > '${outsidePath}'`
      })
    ).rejects.toThrow("outside the workspace");
  });

  it("rejects later write segments that escape the workspace boundary", async () => {
    const cwd = await makeWorkspace();
    const outsideDir = await mkdtemp(join(os.tmpdir(), "coding-agent-action-outside-"));
    tempDirs.push(outsideDir);
    const outsidePath = join(outsideDir, "escape.txt");
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
      config: {
        approvalPolicy: "auto",
        baseUrl: "http://localhost:1234/v1",
        maxSteps: 8,
        model: "gpt-4.1-mini",
        networkEgress: false,
        profileName: "local",
        timeout: undefined
      },
      cwd,
      verificationCommands: ["npm test"]
    });

    await expect(tool.run({ command: `pwd && touch '${outsidePath}'` })).rejects.toThrow(
      "outside the workspace"
    );
    await expect(tool.run({ command: `cat missing || touch '${outsidePath}'` })).rejects.toThrow(
      "outside the workspace"
    );
    await expect(tool.run({ command: `npm test | tee '${outsidePath}'` })).rejects.toThrow(
      "outside the workspace"
    );
  });

  it("allows shell commands that write inside a workspace subdirectory", async () => {
    const cwd = await makeWorkspace();
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
      config: {
        approvalPolicy: "auto",
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
        command: "cd src && printf 'nested' > nested.txt"
      })
    ).resolves.toContain("\"changedFiles\":[\"src/nested.txt\"]");

    await expect(readFile(join(cwd, "src", "nested.txt"), "utf8")).resolves.toBe("nested");
  });

  it("fails patch deletes when the target file is missing", async () => {
    const cwd = await makeWorkspace();
    const tool = createApplyPatchTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
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
            type: "delete",
            path: "src/missing.ts"
          }
        ]
      })
    ).rejects.toThrow("Cannot delete missing file `src/missing.ts`.");
  });

  it("rolls back patch batches when a later operation fails", async () => {
    const cwd = await makeWorkspace();
    const artifacts: unknown[] = [];
    const changedFiles: string[] = [];
    const observations: unknown[] = [];
    const tool = createApplyPatchTool({
      addApproval: () => undefined,
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
          },
          {
            type: "replace",
            path: "src/config.ts",
            oldText: "missing",
            newText: "value = 3"
          }
        ]
      })
    ).rejects.toThrow("Old text was not found");

    await expect(readFile(join(cwd, "src", "config.ts"), "utf8")).resolves.toContain(
      "value = 1"
    );
    expect(changedFiles).toEqual([]);
    expect(artifacts).toEqual([]);
    expect(observations).toEqual([]);
  });

  it("rejects create operations when the target file already exists", async () => {
    const cwd = await makeWorkspace();
    const tool = createApplyPatchTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
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
            type: "create",
            path: "src/config.ts",
            content: "export const value = 2;\n"
          }
        ]
      })
    ).rejects.toThrow("already exists");
  });

  it("rejects replace operations when the target text is ambiguous", async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, "src", "dup.ts"), "needle\nneedle\n", "utf8");
    const tool = createApplyPatchTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
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
            path: "src/dup.ts",
            oldText: "needle",
            newText: "value"
          }
        ]
      })
    ).rejects.toThrow("exactly once");
  });

  it("enforces configured shell command timeouts", async () => {
    const cwd = await makeWorkspace();
    const tool = createRunShellTool({
      addApproval: () => undefined,
      addArtifacts: () => undefined,
      addChangedFiles: () => undefined,
      addObservation: () => undefined,
      addVerificationRun: () => undefined,
      config: {
        approvalPolicy: "auto",
        baseUrl: "http://localhost:1234/v1",
        maxSteps: 8,
        model: "gpt-4.1-mini",
        networkEgress: false,
        profileName: "local",
        timeout: "1ms"
      },
      cwd,
      verificationCommands: []
    });

    await expect(tool.run({ command: "sleep 2" })).rejects.toThrow("timed out");
  });
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(os.tmpdir(), "coding-agent-action-workspace-"));
  tempDirs.push(cwd);

  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "config.ts"), "export const value = 1;\n", "utf8");

  return cwd;
}
