import type { ResolvedExecutionConfig } from "../config/load.js";
import type {
  ContextSectionUsage,
  ContextSnapshot,
  GuidanceSummary,
  Observation,
  PlanState,
  TurnRecord,
  VerificationSummary
} from "../runtime/contracts.js";
import type { RepoContext } from "./context.js";
import { collectContextSnippets, deriveWorkingSet } from "./context.js";

export interface ModelMessage {
  content: string;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string | undefined;
  tool_calls?:
    | Array<{
        function: {
          arguments: string;
          name: string;
        };
        id: string;
        type: "function";
      }>
    | undefined;
}

interface ReplayUnit {
  messages: ModelMessage[];
  startIndex: number;
}

export async function buildRequestContext(args: {
  changedFiles: string[];
  config: ResolvedExecutionConfig;
  cwd: string;
  guidance: GuidanceSummary;
  observations: Observation[];
  pendingApprovalSummary: string | null;
  plan: PlanState | null;
  prompt: string;
  repoContext: RepoContext;
  systemPrompt: string;
  turns: TurnRecord[];
  verification: VerificationSummary;
  verificationCommands: string[];
}): Promise<{
  context: ContextSnapshot;
  messages: ModelMessage[];
}> {
  const workingSet = deriveWorkingSet({
    changedFiles: args.changedFiles,
    observations: args.observations,
    prompt: args.prompt,
    repoContext: args.repoContext,
    turns: args.turns,
    verification: args.verification
  });
  const snippets = await collectContextSnippets({
    cwd: args.cwd,
    prompt: args.prompt,
    turns: args.turns,
    workingSet
  });
  const recentTurns = collectRecentConversationTurns(args.turns);
  const historySummary = summarizeOlderTurns(args.turns, recentTurns.rawCount);
  const sections = buildContextSections({
    changedFiles: args.changedFiles,
    guidance: args.guidance,
    historySummary,
    pendingApprovalSummary: args.pendingApprovalSummary,
    plan: args.plan,
    repoContext: args.repoContext,
    snippets,
    verification: args.verification,
    verificationCommands: args.verificationCommands,
    workingSet
  });
  const systemPromptTokens = estimateTokens(args.systemPrompt);
  const recentTurnSections = recentTurns.messages.map((message, index) => ({
    name: `recent-turn:${index + 1}`,
    tokens: estimateTokens(message.content)
  }));
  const outputReserveTokens = resolveOutputReserve(args.config.contextWindowTokens);
  const maxInputTokens =
    args.config.contextWindowTokens === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, args.config.contextWindowTokens - outputReserveTokens);
  const includedSections: Array<{ content: string; name: string; tokens: number }> = [];
  const droppedSections: string[] = [];
  let usedTokens = systemPromptTokens + recentTurnSections.reduce((sum, section) => sum + section.tokens, 0);

  for (const section of sections) {
    const tokens = estimateTokens(section.content);

    if (usedTokens + tokens > maxInputTokens) {
      droppedSections.push(section.name);
      continue;
    }

    usedTokens += tokens;
    includedSections.push({
      content: section.content,
      name: section.name,
      tokens
    });
  }

  const context: ContextSnapshot = {
    budget: {
      contextWindowTokens: args.config.contextWindowTokens ?? null,
      droppedSections,
      inputTokens: usedTokens,
      outputReserveTokens,
      remainingTokens:
        args.config.contextWindowTokens === undefined
          ? null
          : Math.max(0, args.config.contextWindowTokens - outputReserveTokens - usedTokens),
      sections: [
        {
          name: "system-prompt",
          tokens: systemPromptTokens
        },
        ...includedSections.map<ContextSectionUsage>((section) => ({
          name: section.name,
          tokens: section.tokens
        })),
        ...recentTurnSections
      ],
      usedPercent:
        args.config.contextWindowTokens === undefined
          ? null
          : Math.min(
              100,
              Math.round(
                (usedTokens / Math.max(1, args.config.contextWindowTokens - outputReserveTokens)) *
                  100
              )
            )
    },
    historySummary,
    recentTurnCount: recentTurns.rawCount,
    snippets,
    workingSet
  };

  return {
    context,
    messages: [
      {
        content: [args.systemPrompt, ...includedSections.map((section) => section.content)].join("\n\n"),
        role: "system"
      },
      ...recentTurns.messages
    ]
  };
}

function buildContextSections(args: {
  changedFiles: string[];
  guidance: GuidanceSummary;
  historySummary: string | null;
  pendingApprovalSummary: string | null;
  plan: PlanState | null;
  repoContext: RepoContext;
  snippets: ContextSnapshot["snippets"];
  verification: VerificationSummary;
  verificationCommands: string[];
  workingSet: ContextSnapshot["workingSet"];
}): Array<{ content: string; name: string }> {
  const sections: Array<{ content: string; name: string; priority: number }> = [];

  if (args.guidance.activeRules.length > 0) {
    sections.push({
      content: ["Active guidance:", ...args.guidance.activeRules.map((rule) => `- ${rule}`)].join("\n"),
      name: "guidance",
      priority: 100
    });
  }

  const pinnedStateLines = [
    args.plan
      ? `Plan: ${args.plan.summary} | ${args.plan.items.map((item) => `[${item.status}] ${item.content}`).join(" ; ")}`
      : null,
    args.pendingApprovalSummary ? `Pending approval: ${args.pendingApprovalSummary}` : null,
    args.changedFiles.length > 0 ? `Changed files: ${args.changedFiles.join(", ")}` : null,
    args.verification.status === "failed"
      ? `Verification failures: ${args.verification.runs
          .filter((run) => !run.passed)
          .map((run) => run.command)
          .join(", ")}`
      : null,
    args.verification.status === "not_run" && args.verification.notRunReason
      ? `Verification not run: ${args.verification.notRunReason}`
      : null
  ].filter((line): line is string => line !== null);
  if (pinnedStateLines.length > 0) {
    sections.push({
      content: ["Pinned execution state:", ...pinnedStateLines].join("\n"),
      name: "pinned-state",
      priority: 96
    });
  }

  sections.push({
    content: [
      "Workspace summary:",
      args.repoContext.isGitRepo ? "Git repository detected." : "No git repository detected.",
      args.repoContext.guidanceFiles.length > 0
        ? `Guidance files: ${args.repoContext.guidanceFiles.join(", ")}.`
        : "No guidance files detected.",
      args.repoContext.topLevelEntries.length > 0
        ? `Top-level entries: ${args.repoContext.topLevelEntries.join(", ")}.`
        : "Workspace is empty.",
      Object.keys(args.repoContext.packageScripts).length > 0
        ? `Package scripts: ${Object.keys(args.repoContext.packageScripts).join(", ")}.`
        : "No package scripts detected.",
      args.verificationCommands.length > 0
        ? `Likely verification commands: ${args.verificationCommands.join(", ")}.`
        : "No verification commands inferred."
    ].join("\n"),
    name: "workspace-summary",
    priority: 88
  });

  if (args.workingSet.length > 0) {
    sections.push({
      content: [
        "Active working set:",
        ...args.workingSet.map((entry) => `- ${entry.path}: ${entry.reason}`)
      ].join("\n"),
      name: "working-set",
      priority: 92
    });
  }

  if (args.historySummary) {
    sections.push({
      content: `Earlier conversation summary:\n${args.historySummary}`,
      name: "history-summary",
      priority: 84
    });
  }

  for (const snippet of args.snippets) {
    sections.push({
      content: `Relevant code from ${snippet.path} (${snippet.reason}):\n${snippet.excerpt}`,
      name: `snippet:${snippet.path}`,
      priority: 90
    });
  }

  return sections
    .sort((left, right) => right.priority - left.priority)
    .map(({ content, name }) => ({ content, name }));
}

function collectRecentConversationTurns(turns: TurnRecord[]): {
  messages: ModelMessage[];
  rawCount: number;
} {
  const recentUnits = collectReplayUnits(turns).slice(-8);
  const messages = recentUnits.flatMap((unit) => unit.messages);

  return {
    messages,
    rawCount: recentUnits.length === 0 ? 0 : Math.max(0, turns.length - recentUnits[0]!.startIndex)
  };
}

function collectReplayUnits(turns: TurnRecord[]): ReplayUnit[] {
  const replayableTurns = turns
    .map((turn, index) => ({ index, turn }))
    .filter(({ turn }) =>
      turn.kind === "assistant" ||
      turn.kind === "tool_call" ||
      turn.kind === "tool_result" ||
      turn.kind === "user"
    );
  const units: ReplayUnit[] = [];

  for (let index = 0; index < replayableTurns.length; index += 1) {
    const entry = replayableTurns[index];

    if (!entry) {
      continue;
    }

    const { turn } = entry;

    if (turn.kind === "assistant" || turn.kind === "user") {
      units.push({
        messages: [
          {
            content: turn.text,
            role: turn.kind === "assistant" ? "assistant" : "user"
          }
        ],
        startIndex: entry.index
      });
      continue;
    }

    if (turn.kind !== "tool_call" || !turn.toolCallId) {
      continue;
    }

    const nextEntry = replayableTurns[index + 1];
    if (!nextEntry || nextEntry.turn.kind !== "tool_result") {
      continue;
    }

    if (nextEntry.turn.toolCallId !== turn.toolCallId || nextEntry.turn.content === undefined) {
      continue;
    }

    units.push({
      messages: [
        {
          content: "",
          role: "assistant",
          tool_calls: [
            {
              function: {
                arguments: turn.inputArguments ?? turn.inputSummary,
                name: turn.tool
              },
              id: turn.toolCallId,
              type: "function"
            }
          ]
        },
        {
          content: nextEntry.turn.content,
          role: "tool",
          tool_call_id: turn.toolCallId
        }
      ],
      startIndex: entry.index
    });
    index += 1;
  }

  return units;
}

function summarizeOlderTurns(turns: TurnRecord[], recentRawCount: number): string | null {
  const cutoff = Math.max(0, turns.length - recentRawCount);
  const older = turns.slice(0, cutoff);

  if (older.length === 0) {
    return null;
  }

  const lines = older.slice(-12).map((turn) => {
    if (turn.kind === "tool_call") {
      return `- Tool call ${turn.tool}: ${truncate(turn.inputSummary, 120)}`;
    }

    if (turn.kind === "tool_result") {
      const prefix = turn.error ? "failed" : "completed";
      return `- Tool ${prefix} ${turn.tool}: ${truncate(turn.summary, 120)}`;
    }

    return `- ${turn.kind}: ${truncate(turn.text, 120)}`;
  });

  return lines.join("\n");
}

function resolveOutputReserve(contextWindowTokens: number | undefined): number {
  if (contextWindowTokens === undefined) {
    return 1024;
  }

  return Math.min(4096, Math.max(1024, Math.floor(contextWindowTokens * 0.2)));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
