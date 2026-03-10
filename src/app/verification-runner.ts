import { executeShellCommand, shellResultToVerificationRun } from "./shell.js";
import type { VerificationSummary } from "../cli/output.js";

export async function runVerificationCommands(args: {
  commands: string[];
  cwd: string;
}): Promise<VerificationSummary> {
  if (args.commands.length === 0) {
    return {
      commands: [],
      inferred: true,
      notRunReason: "No verification commands were inferred.",
      passed: false,
      ran: false,
      runs: [],
      status: "not_run"
    };
  }

  const runs = [];

  for (const command of args.commands) {
    const result = await executeShellCommand({
      command,
      cwd: args.cwd
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
    status: runs.every((run) => run.passed) ? "passed" : "failed"
  };
}
