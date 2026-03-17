import type { LoadedGuidance } from "./guidance.js";
import type { RepoContext } from "./context.js";
import type { PlanState, TurnRecord } from "../runtime/contracts.js";

const MAX_CONTEXT_CHARS = 16_000;
const SECTION_BUDGET = {
  observations: 2_000,
  snippets: 5_000,
  turns: 3_000
} as const;

export function buildExecutionContext(args: {
  changedFiles: string[];
  cwd: string;
  guidance: LoadedGuidance;
  observations: Array<{ summary: string }>;
  plan: PlanState | null;
  prompt: string;
  readOnlyTask: boolean;
  repoContext: RepoContext;
  turns: TurnRecord[];
  verificationCommands: string[];
}): string {
  const sections: string[] = [];

  pushSection(sections, ["Current user request:", args.prompt]);
  pushSection(sections, [
    "Workspace summary:",
    `Working directory: ${args.cwd}`,
    args.readOnlyTask ? "Task mode: read-only inspection." : "Task mode: normal editing workflow.",
    args.repoContext.isGitRepo ? "Git repository detected." : "No git repository detected.",
    args.repoContext.guidanceFiles.length > 0
      ? `Guidance files: ${args.repoContext.guidanceFiles.join(", ")}.`
      : "No guidance files detected.",
    args.repoContext.topLevelEntries.length > 0
      ? `Workspace entries: ${args.repoContext.topLevelEntries.join(", ")}.`
      : "Workspace is empty.",
    Object.keys(args.repoContext.packageScripts).length > 0
      ? `Package scripts: ${Object.keys(args.repoContext.packageScripts).join(", ")}.`
      : "No package scripts detected.",
    !args.readOnlyTask && args.verificationCommands.length > 0
      ? `Likely verification commands: ${args.verificationCommands.join(", ")}.`
      : args.readOnlyTask
        ? "Verification is not required unless the user explicitly asks for it."
        : "No verification commands inferred yet."
  ]);

  if (args.guidance.summary.activeRules.length > 0) {
    pushSection(sections, [
      "Active guidance:",
      ...args.guidance.summary.activeRules.map((rule) => `- ${rule}`)
    ]);
  }

  if (args.plan) {
    pushSection(sections, [
      "Current plan:",
      `${args.plan.summary} | ${args.plan.items
        .map((item) => `[${item.status}] ${item.content}`)
        .join(" ; ")}`
    ]);
  }

  if (args.changedFiles.length > 0) {
    pushSection(sections, [`Changed files so far: ${args.changedFiles.join(", ")}`]);
  }

  const turnLines = summarizeTurns(args.turns);
  if (turnLines.length > 0) {
    pushSection(sections, ["Conversation so far:", ...truncateLines(turnLines, SECTION_BUDGET.turns)]);
  }

  if (args.observations.length > 0) {
    pushSection(sections, [
      "Recent observations:",
      ...truncateLines(
        dedupeLines(args.observations.slice(-6).map((observation) => `- ${observation.summary}`)),
        SECTION_BUDGET.observations
      )
    ]);
  }

  const snippetSections = args.repoContext.snippets.flatMap((snippet) => [
    `Snippet from ${snippet.path}:`,
    snippet.content
  ]);
  if (snippetSections.length > 0) {
    pushSection(sections, truncateLines(snippetSections, SECTION_BUDGET.snippets));
  }

  for (const layer of args.guidance.layers) {
    if (layer.source === "task") {
      continue;
    }

    pushSection(sections, truncateLines([`Guidance from ${layer.path}:`, layer.content], 1_500));
  }

  return sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
}

function summarizeTurns(turns: TurnRecord[]): string[] {
  return (turns ?? []).slice(-10).map((turn) => {
    if (turn.kind === "tool_call") {
      return `- Tool call ${turn.tool}: ${turn.inputSummary}`;
    }

    if (turn.kind === "tool_result") {
      return `- Tool result ${turn.tool}: ${turn.summary}`;
    }

    return `- ${turn.kind}: ${turn.text}`;
  });
}

function pushSection(target: string[], lines: string[]): void {
  const content = lines.filter(Boolean).join("\n");

  if (content.length > 0) {
    target.push(content);
  }
}

function truncateLines(lines: string[], budget: number): string[] {
  const output: string[] = [];
  let remaining = budget;

  for (const line of lines) {
    if (remaining <= 0) {
      break;
    }

    if (line.length <= remaining) {
      output.push(line);
      remaining -= line.length + 1;
      continue;
    }

    output.push(`${line.slice(0, Math.max(0, remaining - 3))}...`);
    break;
  }

  return output;
}

function dedupeLines(lines: string[]): string[] {
  return [...new Set(lines)];
}
