import { executeShellCommand, shellResultToVerificationRun } from "./shell.js";
import type { VerificationSummary } from "../cli/output.js";

export async function runVerificationCommands(args: {
  commands: string[];
  cwd: string;
}): Promise<VerificationSummary> {
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
        passed: false,
        runs
      };
    }
  }

  return {
    commands: args.commands,
    inferred: true,
    passed: runs.every((run) => run.passed),
    runs
  };
}
