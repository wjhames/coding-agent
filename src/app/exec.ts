import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommandResult } from "../cli/output.js";
import { resolveExecutionConfig, loadConfig } from "../config/load.js";
import type { ParsedOptions } from "../cli/parse.js";
import { createSession } from "../session/store.js";

export async function runExec(args: {
  options: ParsedOptions;
  prompt: string;
  processCwd: string | undefined;
  sessionHomeDir: string | undefined;
}): Promise<CommandResult> {
  const cwd = resolve(args.processCwd ?? process.cwd(), args.options.cwd ?? ".");
  const config = await loadConfig(cwd);
  const resolvedConfig = resolveExecutionConfig({
    cliOptions: args.options,
    config
  });
  const inspection = await inspectWorkspace(cwd);
  const summary = buildExecSummary({
    cwd,
    inspection,
    prompt: args.prompt
  });
  const session = await createSession(
    {
      config: resolvedConfig,
      cwd,
      mode: "exec",
      prompt: args.prompt,
      status: "completed",
      summary,
      verification: {
        commands: [],
        passed: false
      }
    },
    args.sessionHomeDir
  );

  return {
    sessionId: session.id,
    status: session.status,
    summary: session.summary,
    changedFiles: session.changedFiles,
    artifacts: session.artifacts,
    verification: session.verification,
    approvals: session.approvals,
    exitCode: 0
  };
}

interface WorkspaceInspection {
  entries: string[];
  guidanceFiles: string[];
  isGitRepo: boolean;
}

async function inspectWorkspace(cwd: string): Promise<WorkspaceInspection> {
  const entries = (await readdir(cwd)).sort();
  const guidanceFiles = entries.filter((entry) =>
    ["AGENTS.md", "CLAUDE.md", "README.md"].includes(entry)
  );
  const isGitRepo = await hasPath(resolve(cwd, ".git"));

  return {
    entries,
    guidanceFiles,
    isGitRepo
  };
}

function buildExecSummary(args: {
  cwd: string;
  inspection: WorkspaceInspection;
  prompt: string;
}): string {
  const repoLine = args.inspection.isGitRepo ? "Git repository detected." : "No git repository detected.";
  const guidanceLine =
    args.inspection.guidanceFiles.length > 0
      ? `Guidance files: ${args.inspection.guidanceFiles.join(", ")}.`
      : "No guidance files detected.";
  const sampleEntries = args.inspection.entries.slice(0, 5);
  const entriesLine =
    sampleEntries.length > 0
      ? `Workspace entries: ${sampleEntries.join(", ")}.`
      : "Workspace is empty.";

  return [
    `Prepared execution for prompt: ${args.prompt}`,
    `Working directory: ${args.cwd}`,
    repoLine,
    guidanceLine,
    entriesLine
  ].join("\n");
}

async function hasPath(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
