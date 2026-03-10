import { writeFile } from "node:fs/promises";
import type { CommandError, CommandResult } from "../runtime/contracts.js";

export type {
  Approval,
  Artifact,
  CommandError,
  CommandResult,
  CompactionSummary,
  GuidanceSource,
  GuidanceSummary,
  MemoryEntry,
  MemorySummary,
  Observation,
  PendingAction,
  PendingApprovalInfo,
  PlanItem,
  PlanState,
  RepoContextSummary,
  SessionConfig,
  SessionMode,
  SessionStatus,
  ToolName,
  VerificationRun,
  VerificationSkipped,
  VerificationSummary
} from "../runtime/contracts.js";

export interface CliIO {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

export async function writeCommandResult(
  io: CliIO,
  result: CommandResult,
  json: boolean,
  outputPath?: string
): Promise<void> {
  const body = json ? `${JSON.stringify(result, null, 2)}\n` : `${result.summary}\n`;

  if (outputPath) {
    await writeFile(outputPath, body, "utf8");
    return;
  }

  io.stdout.write(body);
}

export async function writeCommandError(
  io: CliIO,
  error: CommandError,
  json: boolean,
  outputPath?: string
): Promise<void> {
  const body = json ? `${JSON.stringify(error, null, 2)}\n` : `${error.message}\n`;

  if (outputPath) {
    await writeFile(outputPath, body, "utf8");
    return;
  }

  io.stderr.write(body);
}
