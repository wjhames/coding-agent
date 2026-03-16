import type { SessionRecord } from "../session/aggregate.js";
import type { ResolvedExecutionConfig } from "../config/load.js";
import type { ExecutionState } from "./state.js";
import { serializePlan } from "./state.js";

export function buildSystemPrompt(args: {
  config: ResolvedExecutionConfig;
  readOnlyTask: boolean;
}): string {
  return [
    "You are a CLI coding agent.",
    "Investigate before editing.",
    args.readOnlyTask
      ? "This is a read-only task. Do not edit files or run verification unless the user explicitly asks."
      : "Edit files only when the task requires it.",
    args.readOnlyTask
      ? "Keep read-only summaries concise and grounded in files or command output you actually inspected."
      : "Keep summaries grounded in files or command output you actually inspected.",
    "Prefer list_files and search_files before read_file when locating code.",
    "Use workspace-relative paths for file tools unless the user explicitly gave an absolute file path.",
    "Do not call read_file on directories; use list_files for directories.",
    "Prefer file tools over run_shell for repository inspection.",
    "Use write_plan before the final answer.",
    "Use list_files, search_files, and read_file to gather context.",
    "Use apply_patch for file edits.",
    "Use run_shell for verification or necessary commands.",
    "If a tool returns an error, adapt and continue rather than repeating the same failing call.",
    "Avoid heavy or ignored directories like node_modules, dist, coverage, and .notes unless the task requires them.",
    `Approval policy is ${args.config.approvalPolicy ?? "prompt"}.`,
    "Do not claim tests ran or files changed when they did not.",
    "Do not speculate about test failures, implementation gaps, or repository state that you did not directly observe.",
    "If something was not inspected, say so instead of guessing.",
    "If you make code changes, ensure verification is possible."
  ].join(" ");
}

export function buildResumePrompt(session: SessionRecord): string {
  return [
    session.prompt,
    "",
    "Resuming previous session.",
    session.plan ? `Plan: ${serializePlan(session.plan)}` : "No stored plan.",
    session.compaction.observationSummary
      ? `Compaction: ${session.compaction.observationSummary}`
      : "No compaction summary yet.",
    session.memory.working.length > 0
      ? `Working memory: ${session.memory.working.map((entry) => entry.summary).join(" | ")}`
      : "No working memory yet.",
    session.changedFiles.length > 0
      ? `Changed files so far: ${session.changedFiles.join(", ")}.`
      : "No changed files yet.",
    session.observations.length > 0
      ? `Recent observations: ${session.observations
          .slice(-5)
          .map((observation) => observation.summary)
          .join(" | ")}`
      : "No prior observations."
  ].join("\n");
}

export function isLikelyReadOnlyTask(prompt: string): boolean {
  const lowered = prompt.toLowerCase();
  const writeIntent = [
    "fix",
    "change",
    "edit",
    "update",
    "modify",
    "create",
    "write",
    "delete",
    "remove",
    "rename",
    "refactor",
    "implement",
    "patch",
    "add "
  ];

  if (writeIntent.some((token) => lowered.includes(token))) {
    return false;
  }

  const readOnlyIntent = [
    "inspect",
    "summarize",
    "summary",
    "explain",
    "review",
    "analyze",
    "analyse",
    "understand",
    "describe",
    "walk through",
    "what does"
  ];

  return readOnlyIntent.some((token) => lowered.includes(token));
}

export function buildVerificationFailurePrompt(args: {
  originalPrompt: string;
  state: ExecutionState;
}): string {
  const failedRuns = args.state.verification.runs.filter((run) => !run.passed);
  return [
    args.originalPrompt,
    "",
    "Verification failed. Investigate and repair the issue.",
    ...failedRuns.flatMap((run) => [
      `Command: ${run.command}`,
      `Exit code: ${run.exitCode}`,
      `stdout:\n${run.stdout}`,
      `stderr:\n${run.stderr}`
    ])
  ].join("\n");
}
