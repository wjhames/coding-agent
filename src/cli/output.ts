import { writeFile } from "node:fs/promises";

export interface PlanItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanState {
  summary: string;
  items: PlanItem[];
}

export interface RepoContextSummary {
  guidanceFiles: string[];
  isGitRepo: boolean;
  topLevelEntries: string[];
}

export interface VerificationSummary {
  commands: string[];
  inferred: boolean;
  passed: boolean;
}

export interface CommandResult {
  artifacts: string[];
  verification: VerificationSummary;
  approvals: string[];
  exitCode: 0 | 1 | 2;
  changedFiles: string[];
  nextActions: string[];
  plan: PlanState | null;
  repoContext: RepoContextSummary;
  sessionId: string | null;
  status: "completed" | "failed" | "paused";
  summary: string;
  resumedFrom?: string | null;
}

export interface CommandError {
  error: string;
  message: string;
  exitCode: 1 | 2;
  sessionId?: string | null;
}

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
  const body = json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${result.summary}\n`;

  if (outputPath) {
    await writeFile(outputPath, body, "utf8");
  } else {
    io.stdout.write(body);
  }
}

export async function writeCommandError(
  io: CliIO,
  error: CommandError,
  json: boolean,
  outputPath?: string
): Promise<void> {
  const body = json
    ? `${JSON.stringify(error, null, 2)}\n`
    : `${error.message}\n`;

  if (outputPath) {
    await writeFile(outputPath, body, "utf8");
  } else {
    io.stderr.write(body);
  }
}
