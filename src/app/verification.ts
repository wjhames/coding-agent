import { normalizeShellCommand } from "./approval.js";
import type { VerificationRun, VerificationSummary } from "../runtime/contracts.js";

export interface VerificationPlan {
  commands: string[];
  selectedCommands: string[];
  skippedCommands: Array<{
    command: string;
    reason: string;
  }>;
}

const VERIFICATION_ORDER = [
  {
    command: "npm run lint",
    defaultSelected: true,
    detect: /\blint\b|npm run lint/,
    script: "lint"
  },
  {
    command: "npm run typecheck",
    defaultSelected: true,
    detect: /\btype-?check\b|\btsc\b|npm run typecheck/,
    script: "typecheck"
  },
  {
    command: "npm run build",
    defaultSelected: false,
    detect: /\bbuild\b|npm run build/,
    script: "build"
  },
  {
    command: "npm test",
    defaultSelected: true,
    detect: /\btests?\b|npm test/,
    script: "test"
  },
  {
    command: "npm run check",
    defaultSelected: true,
    detect: /\bchecks?\b|npm run check/,
    script: "check"
  }
] as const;

export function planVerificationCommands(args: {
  assistantSummary?: string;
  changedFiles: string[];
  packageScripts: Record<string, string>;
  prompt: string;
}): VerificationPlan {
  const selectedCommands = new Set<string>();
  const skippedCommands = new Map<string, string>();
  const changedFilesMade = args.changedFiles.length > 0;
  const promptIntent = detectVerificationIntent(args.prompt);
  const summaryIntent = detectVerificationIntent(args.assistantSummary ?? "");
  const requestedScripts = new Set<string>([
    ...promptIntent.scripts,
    ...summaryIntent.scripts
  ]);
  const useDefaultVerification =
    changedFilesMade ||
    promptIntent.generic ||
    summaryIntent.generic;

  for (const candidate of VERIFICATION_ORDER) {
    const explicitlyRequested = requestedScripts.has(candidate.script);
    const shouldSelect =
      explicitlyRequested || (useDefaultVerification && candidate.defaultSelected);

    if (!shouldSelect) {
      continue;
    }

    if (candidate.script in args.packageScripts) {
      selectedCommands.add(candidate.command);
      continue;
    }

    skippedCommands.set(candidate.command, `Script \`${candidate.script}\` is not defined.`);
  }

  return {
    commands: [...selectedCommands],
    selectedCommands: [...selectedCommands],
    skippedCommands: [...skippedCommands.entries()].map(([command, reason]) => ({
      command,
      reason
    }))
  };
}

export function inferVerificationCommands(args: {
  assistantSummary?: string;
  changedFiles: string[];
  packageScripts: Record<string, string>;
  prompt: string;
}): string[] {
  return planVerificationCommands(args).selectedCommands;
}

export function commandMatchesVerificationCommand(args: {
  actual: string;
  expected: string;
}): boolean {
  return normalizeShellCommand(args.actual) === normalizeShellCommand(args.expected);
}

export function summarizeVerificationEvidence(args: {
  commands: string[];
  runs: VerificationRun[];
  skippedCommands: Array<{
    command: string;
    reason: string;
  }>;
}): VerificationSummary {
  const matchedRuns = args.runs.filter((run) =>
    args.commands.some((command) =>
      commandMatchesVerificationCommand({
        actual: run.command,
        expected: command
      })
    )
  );

  if (args.commands.length === 0) {
    return {
      commands: [],
      inferred: true,
      notRunReason: "No verification commands were inferred.",
      passed: false,
      ran: false,
      runs: [],
      selectedCommands: [],
      skippedCommands: args.skippedCommands,
      status: "not_run"
    };
  }

  const latestRuns = args.commands.map((command) =>
    [...matchedRuns]
      .reverse()
      .find((run) =>
        commandMatchesVerificationCommand({
          actual: run.command,
          expected: command
        })
      ) ?? null
  );
  const hasFailingEvidence = latestRuns.some((run) => run !== null && !run.passed);
  const allCommandsPassed =
    latestRuns.every((run) => run !== null) &&
    latestRuns.every((run) => run?.passed === true);
  const status =
    allCommandsPassed ? "passed" : hasFailingEvidence ? "failed" : "not_run";

  return {
    commands: args.commands,
    inferred: true,
    notRunReason:
      status === "not_run"
        ? matchedRuns.length === 0
          ? "Verification has not run yet."
          : "Verification is incomplete."
        : null,
    passed: status === "passed",
    ran: matchedRuns.length > 0,
    runs: matchedRuns,
    selectedCommands: args.commands,
    skippedCommands: args.skippedCommands,
    status
  };
}

function detectVerificationIntent(text: string): {
  generic: boolean;
  scripts: string[];
} {
  const normalized = text.toLowerCase();
  const scripts = VERIFICATION_ORDER.filter((candidate) => candidate.detect.test(normalized)).map(
    (candidate) => candidate.script
  );

  return {
    generic:
      /\bverify\b|\bverification\b|\bvalidate\b|\bvalidated\b|\brun the checks\b/.test(
        normalized
      ),
    scripts
  };
}
