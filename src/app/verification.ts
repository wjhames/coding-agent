export interface VerificationPlan {
  commands: string[];
  skippedCommands: Array<{
    command: string;
    reason: string;
  }>;
}

const VERIFICATION_ORDER = [
  { command: "npm run lint", script: "lint" },
  { command: "npm run typecheck", script: "typecheck" },
  { command: "npm test", script: "test" },
  { command: "npm run check", script: "check" }
] as const;

export function planVerificationCommands(args: {
  packageScripts: Record<string, string>;
}): VerificationPlan {
  const commands: string[] = [];
  const skippedCommands: VerificationPlan["skippedCommands"] = [];

  for (const candidate of VERIFICATION_ORDER) {
    if (candidate.script in args.packageScripts) {
      commands.push(candidate.command);
      continue;
    }

    skippedCommands.push({
      command: candidate.command,
      reason: `Script \`${candidate.script}\` is not defined.`
    });
  }

  return {
    commands,
    skippedCommands
  };
}

export function inferVerificationCommands(args: {
  packageScripts: Record<string, string>;
}): string[] {
  return planVerificationCommands(args).commands;
}
