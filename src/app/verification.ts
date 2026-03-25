import { normalizeShellCommand } from "./approval.js";
import type { RepoContext, VerificationSignal } from "./context.js";
import {
  isReadOnlyShellSegment,
  normalizeShellSegmentForComparison,
  parseShellCommandSegments
} from "./shell.js";
import type { VerificationRun, VerificationSummary } from "../runtime/contracts.js";

export interface VerificationPlan {
  commands: string[];
  selectedCommands: string[];
  skippedCommands: Array<{
    command: string;
    reason: string;
  }>;
}

interface VerificationIntent {
  generic: boolean;
  kinds: Set<VerificationSignal["kind"]>;
}

const PROMPT_KIND_PATTERNS: Record<VerificationSignal["kind"], RegExp> = {
  build: /\brun (?:the )?build\b|npm run build/,
  check: /\brun (?:the )?checks?\b|npm run check/,
  lint: /\brun (?:the )?lint(?:ing)?\b|\brun ruff\b|\bruff check\b|npm run lint/,
  test: /\b(?:run|execute|verify)\b[^.\n]{0,40}\btests?\b|\bpytest\b|\bcargo test\b|\bgo test\b|\bmvn(?:w)? test\b|\bgradle(?:w)? test\b|npm test/,
  typecheck: /\brun (?:the )?type-?check\b|\btsc\b|\bmypy\b|npm run typecheck/
};

const SUMMARY_KIND_PATTERNS: Record<VerificationSignal["kind"], RegExp> = {
  build: /\b(?:ran|running|run|passed|failed)\b[^.\n]{0,40}\bbuild\b|npm run build/,
  check: /\b(?:ran|running|run|passed|failed)\b[^.\n]{0,40}\bchecks?\b|npm run check/,
  lint: /\b(?:ran|running|run|passed|failed)\b[^.\n]{0,40}\blint(?:ing)?\b|\bruff\b|npm run lint/,
  test: /\b(?:ran|running|run|passed|failed|verified)\b[^.\n]{0,40}\btests?\b|\bpytest\b|\bcargo test\b|\bgo test\b|\bmvn(?:w)? test\b|\bgradle(?:w)? test\b|npm test/,
  typecheck: /\b(?:ran|running|run|passed|failed)\b[^.\n]{0,40}\btype-?check\b|\btsc\b|\bmypy\b|npm run typecheck/
};

export function planVerificationCommands(args: {
  assistantSummary?: string;
  changedFiles: string[];
  prompt: string;
  repoContext: Pick<RepoContext, "packageScripts" | "topLevelEntries" | "verificationSignals">;
}): VerificationPlan {
  const selectedCommands = new Set<string>();
  const skippedCommands = new Map<string, string>();
  const changedFilesMade = args.changedFiles.length > 0;
  const promptIntent = detectVerificationIntent(args.prompt);
  const summaryIntent = detectAssistantVerificationIntent(args.assistantSummary ?? "");
  const useDefaultVerification =
    changedFilesMade ||
    promptIntent.generic ||
    summaryIntent.generic;

  for (const signal of args.repoContext.verificationSignals) {
    const relevant = isVerificationSignalRelevant({
      changedFiles: args.changedFiles,
      prompt: args.prompt,
      signal,
      topLevelEntries: args.repoContext.topLevelEntries
    });
    const explicitlyRequested = signalMatchesIntent(signal, promptIntent);
    const requestedBySummary = signalMatchesIntent(signal, summaryIntent);
    const shouldSelect =
      explicitlyRequested ||
      (relevant && requestedBySummary) ||
      (relevant && useDefaultVerification && signal.defaultSelected);

    if (!shouldSelect) {
      continue;
    }

    selectedCommands.add(signal.command);
  }

  if (promptIntent.generic && selectedCommands.size === 0) {
    skippedCommands.set(
      "verification",
      "No trustworthy repo-native verification commands were detected."
    );
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
  prompt: string;
  repoContext: Pick<RepoContext, "packageScripts" | "topLevelEntries" | "verificationSignals">;
}): string[] {
  return planVerificationCommands(args).selectedCommands;
}

export function commandMatchesVerificationCommand(args: {
  actual: string;
  expected: string;
}): boolean {
  const actual = normalizeVerificationComparableCommand(args.actual);
  const expected = normalizeVerificationComparableCommand(args.expected);
  return actual !== null && expected !== null && actual === expected;
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

function detectVerificationIntent(text: string): VerificationIntent {
  const normalized = text.toLowerCase();
  const kinds = new Set<VerificationSignal["kind"]>();

  for (const [kind, pattern] of Object.entries(PROMPT_KIND_PATTERNS) as Array<
    [VerificationSignal["kind"], RegExp]
  >) {
    if (pattern.test(normalized)) {
      kinds.add(kind);
    }
  }

  return {
    generic:
      /\bverify\b|\bverification\b|\bvalidate\b|\bvalidated\b|\brun the checks\b/.test(
        normalized
      ),
    kinds
  };
}

function detectAssistantVerificationIntent(text: string): VerificationIntent {
  const normalized = text.toLowerCase();
  const mentionsVerification =
    /\b(?:verify|verified|verification|validate|validated|passed|failed|running|ran|run)\b/.test(
      normalized
    );

  if (!mentionsVerification) {
    return {
      generic: false,
      kinds: new Set()
    };
  }

  const kinds = new Set<VerificationSignal["kind"]>();

  for (const [kind, pattern] of Object.entries(SUMMARY_KIND_PATTERNS) as Array<
    [VerificationSignal["kind"], RegExp]
  >) {
    if (pattern.test(normalized)) {
      kinds.add(kind);
    }
  }

  return {
    generic:
      /\bverify\b|\bverification\b|\bvalidate\b|\bvalidated\b|\brun the checks\b/.test(
        normalized
      ),
    kinds
  };
}

function signalMatchesIntent(
  signal: VerificationSignal,
  intent: VerificationIntent
): boolean {
  return intent.kinds.has(signal.kind) || (intent.generic && signal.defaultSelected);
}

function isVerificationSignalRelevant(args: {
  changedFiles: string[];
  prompt: string;
  signal: VerificationSignal;
  topLevelEntries: string[];
}): boolean {
  if (args.changedFiles.length === 0) {
    return true;
  }

  if (args.changedFiles.some((path) => pathMatchesSignal(path, args.signal))) {
    return true;
  }

  const prompt = args.prompt.toLowerCase();

  if (args.signal.ecosystem === "npm") {
    return /\b(?:javascript|typescript|node|react|next\.js|nextjs|npm)\b/.test(prompt);
  }

  if (args.signal.ecosystem === "python") {
    return /\bpython\b|\bpytest\b|\bruff\b|\bmypy\b/.test(prompt);
  }

  if (args.signal.ecosystem === "rust") {
    return /\brust\b|\bcargo\b/.test(prompt);
  }

  if (args.signal.ecosystem === "go") {
    return /\bgolang\b|\bgo\b/.test(prompt);
  }

  if (args.signal.ecosystem === "maven" || args.signal.ecosystem === "gradle") {
    return /\bjava\b|\bkotlin\b|\bmaven\b|\bgradle\b/.test(prompt);
  }

  return args.topLevelEntries.includes(args.signal.source);
}

function pathMatchesSignal(path: string, signal: VerificationSignal): boolean {
  const normalizedPath = path.toLowerCase();

  if (normalizedPath === signal.source.toLowerCase()) {
    return true;
  }

  switch (signal.ecosystem) {
    case "npm":
      return (
        /\.(?:[cm]?jsx?|tsx?)$/.test(normalizedPath) ||
        normalizedPath === "package-lock.json" ||
        normalizedPath === "pnpm-lock.yaml" ||
        normalizedPath === "yarn.lock" ||
        normalizedPath.startsWith("pages/") ||
        normalizedPath.startsWith("src/")
      );
    case "python":
      return /\.py$/.test(normalizedPath) || normalizedPath.startsWith("tests/");
    case "rust":
      return /\.rs$/.test(normalizedPath) || normalizedPath.startsWith("src/");
    case "go":
      return /\.go$/.test(normalizedPath);
    case "maven":
    case "gradle":
      return (
        /\.(?:java|kt|kts)$/.test(normalizedPath) ||
        normalizedPath.startsWith("src/main/") ||
        normalizedPath.startsWith("src/test/")
      );
  }
}

function normalizeVerificationComparableCommand(command: string): string | null {
  const segments = parseShellCommandSegments(command);

  if (segments.length === 0) {
    return null;
  }

  const [primary, ...rest] = segments;
  if (!primary) {
    return null;
  }

  if (primary.name === null) {
    return null;
  }

  if (rest.some((segment) => segment.operatorBefore !== "|" || !isReadOnlyShellSegment(segment))) {
    return null;
  }

  return normalizeShellSegmentForComparison(primary) || normalizeShellCommand(command);
}
