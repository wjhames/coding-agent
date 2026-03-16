import type { LoadedGuidance } from "./guidance.js";
import type { RepoContext } from "./context.js";
import type { CompactionSummary, MemorySummary, PlanState } from "../runtime/contracts.js";

const MAX_CONTEXT_CHARS = 16_000;
const SECTION_BUDGET = {
  snippets: 5_000,
  observations: 2_000,
  memory: 2_000,
  verification: 1_500
} as const;

export function buildExecutionContext(args: {
  changedFiles: string[];
  compaction: CompactionSummary;
  cwd: string;
  guidance: LoadedGuidance;
  memory: MemorySummary;
  observations: Array<{ summary: string }>;
  plan: PlanState | null;
  prompt: string;
  readOnlyTask: boolean;
  repoContext: RepoContext;
  verificationCommands: string[];
}): string {
  const sections: string[] = [];

  pushSection(sections, ["User task:", args.prompt]);
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

  const memoryLines = dedupeLines([
    ...args.memory.working.map((entry) => `- ${entry.summary}`),
    ...args.memory.decisions.slice(-4).map((entry) => `- ${entry.summary}`)
  ]);
  if (memoryLines.length > 0) {
    pushSection(sections, ["Memory:", ...truncateLines(memoryLines, SECTION_BUDGET.memory)]);
  }

  const compactedLines = [
    args.compaction.eventSummary,
    args.compaction.observationSummary,
    args.compaction.changedFilesSummary,
    args.compaction.verificationSummary
  ].filter(Boolean) as string[];
  if (compactedLines.length > 0) {
    pushSection(sections, ["Compaction summary:", ...compactedLines.map((line) => `- ${line}`)]);
  }

  if (args.changedFiles.length > 0) {
    pushSection(sections, [`Changed files so far: ${args.changedFiles.join(", ")}`]);
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
