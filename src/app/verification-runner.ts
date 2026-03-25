import { executeShellCommand, shellResultToVerificationRun } from "./shell.js";
import type { VerificationSummary } from "../runtime/contracts.js";

export async function runVerificationCommands(args: {
  commands: string[];
  cwd: string;
  timeoutMs?: number | undefined;
  skippedCommands?: Array<{
    command: string;
    reason: string;
  }>;
}): Promise<VerificationSummary> {
  if (args.commands.length === 0) {
    return {
      commands: [],
      inferred: true,
      notRunReason: "No verification commands were inferred.",
      passed: false,
      ran: false,
      runs: [],
      selectedCommands: [],
      skippedCommands: args.skippedCommands ?? [],
      status: "not_run"
    };
  }

  const runs = [];

  for (const command of args.commands) {
    const result = await executeShellCommand({
      command,
      cwd: args.cwd,
      timeoutMs: args.timeoutMs
    });
    const run = shellResultToVerificationRun({
      command,
      result
    });
    runs.push(run);

    if (!run.passed) {
      return {
        commands: args.commands,
        inferred: true,
        notRunReason: null,
        passed: false,
        ran: true,
        runs,
        selectedCommands: args.commands,
        skippedCommands: args.skippedCommands ?? [],
        status: "failed"
      };
    }
  }

  return {
    commands: args.commands,
    inferred: true,
    notRunReason: null,
    passed: runs.every((run) => run.passed),
    ran: true,
    runs,
    selectedCommands: args.commands,
    skippedCommands: args.skippedCommands ?? [],
    status: runs.every((run) => run.passed) ? "passed" : "failed"
  };
}
