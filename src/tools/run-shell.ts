import { z } from "zod";
import {
  ApprovalDeniedError,
  classifyShellCommand,
  enforceApproval,
  isShellCommandDangerous,
  isShellCommandNetworked,
  isShellCommandReadOnly,
  normalizeShellCommand
} from "../app/approval.js";
import { executeShellCommand, shellResultToObservation } from "../app/shell.js";
import { diffWorkspaceSnapshots, snapshotWorkspace } from "../app/workspace-state.js";
import { createDiffArtifact } from "../app/diff.js";
import type { ResolvedExecutionConfig } from "../config/load.js";
import type { Approval, Artifact, Observation } from "../runtime/contracts.js";
import type { LlmTool } from "../llm/openai-client.js";

const runShellInputSchema = z.object({
  command: z.string().min(1),
  justification: z.string().min(1).optional()
});

export type RunShellInput = z.infer<typeof runShellInputSchema>;

export function createRunShellTool(args: {
  addApproval: (approval: Approval) => void;
  addArtifacts: (artifacts: Artifact[]) => void;
  addChangedFiles: (files: string[]) => void;
  addObservation: (observation: Observation) => void;
  config: ResolvedExecutionConfig;
  cwd: string;
  verificationCommands: string[];
}): LlmTool {
  return {
    description: "Run a shell command inside the workspace.",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "Shell command to run."
        },
        justification: {
          type: "string",
          description: "Short reason for running the command."
        }
      },
      required: ["command"]
    },
    inputSchema: runShellInputSchema,
    name: "run_shell",
    async run(input) {
      const parsed = runShellInputSchema.parse(input);

      if (isShellCommandDangerous(parsed.command)) {
        throw new ApprovalDeniedError("Dangerous shell commands are not allowed.");
      }

      if (args.config.networkEgress === false && isShellCommandNetworked(parsed.command)) {
        throw new ApprovalDeniedError("Networked shell commands are not allowed by config.");
      }

      const requiresApproval = shouldRequireApproval({
        command: parsed.command,
        config: args.config,
        verificationCommands: args.verificationCommands
      });
      const approval = enforceApproval({
        action: parsed,
        actionClass: classifyShellCommand(parsed.command),
        command: parsed.command,
        config: args.config,
        reason: "shell_side_effect",
        requiresApproval,
        summary: `Approval required to run shell command: ${parsed.command}`,
        tool: "run_shell"
      });

      if (approval) {
        args.addApproval(approval);
      }

      return runShellAction({
        addArtifacts: args.addArtifacts,
        addChangedFiles: args.addChangedFiles,
        addObservation: args.addObservation,
        command: parsed.command,
        cwd: args.cwd
      });
    }
  };
}

export async function runShellAction(args: {
  addArtifacts: (artifacts: Artifact[]) => void;
  addChangedFiles: (files: string[]) => void;
  addObservation: (observation: Observation) => void;
  command: string;
  cwd: string;
}): Promise<string> {
  const before = await snapshotWorkspace({ cwd: args.cwd });
  const result = await executeShellCommand({
    command: args.command,
    cwd: args.cwd
  });
  const after = await snapshotWorkspace({ cwd: args.cwd });
  const changedFiles = diffWorkspaceSnapshots({ after, before });
  const artifacts: Artifact[] = [];

  for (const path of changedFiles) {
    artifacts.push(
      await createDiffArtifact({
        after: after.get(path) ?? null,
        before: before.get(path) ?? null,
        path
      })
    );
  }

  if (changedFiles.length > 0) {
    args.addChangedFiles(changedFiles);
    args.addArtifacts(artifacts);
  }

  args.addObservation(shellResultToObservation({ command: args.command, result }));

  return JSON.stringify({
    changedFiles,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout
  });
}

function shouldRequireApproval(args: {
  command: string;
  config: ResolvedExecutionConfig;
  verificationCommands: string[];
}): boolean {
  const normalizedCommand = normalizeCommandForApproval(args.command);

  if (args.verificationCommands.some((command) => normalizeCommandForApproval(command) === normalizedCommand)) {
    return false;
  }

  if (isShellCommandReadOnly(normalizedCommand)) {
    return false;
  }

  return true;
}

function normalizeCommandForApproval(command: string): string {
  return normalizeShellCommand(command);
}
