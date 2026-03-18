import type {
  Approval,
  Artifact,
  CommandResult,
  PendingApprovalInfo,
  PlanState,
  RuntimeEvent,
  ToolName
} from "../runtime/contracts.js";
import { type BlockTone, type InteractiveModel, type TranscriptBlock } from "./state.js";

export function applyRuntimeEventToModel(
  state: InteractiveModel,
  event: RuntimeEvent
): InteractiveModel {
  switch (event.type) {
    case "status":
      return applyStatusEvent(state, event);
    case "context_updated":
      return {
        ...state,
        context: event.context
      };
    case "plan_updated":
      return event.plan
        ? appendActivity(
            {
              ...state,
              liveStatusLabel: "Updating plan",
              plan: event.plan
            },
            {
              bucket: "plan",
              lines: [event.plan.summary, ...event.plan.items.map(formatPlanItemLine)],
              tone: "dim"
            }
          )
        : {
            ...state,
            plan: null
          };
    case "tool_called":
      return event.tool === "write_plan"
        ? {
            ...state,
            liveStatusLabel: "Updating plan"
          }
        : appendActivity(
            {
              ...state,
              liveStatusLabel: liveStatusLabelForTool(event.tool, event.inputSummary, state.cwd)
            },
            toolCalledToActivity(event.tool, event.inputSummary, state.cwd)
          );
    case "tool_result":
      return applyToolResultEvent(state, event);
    case "approval_requested":
      return appendPendingApprovalBlock({
        ...state,
        approvalChoiceIndex: 0,
        liveStatusLabel: "Waiting for approval",
        pendingApproval: toPendingApproval(event.approval, event.pendingAction),
        runtimeStatus: "paused",
        approvals: upsertApproval(state.approvals, event.approval),
        scrollOffset: state.scrollOffset
      }, formatApprovalLines(event.approval, event.pendingAction), `approval:${event.at}`);
    case "approval_resolved":
      return appendApprovalResolutionFeedback(state, event.status);
    case "verification_started":
      return appendActivity(state, {
        bucket: "verification",
        lines: formatVerificationStartLines(event.commands),
        tone: "dim"
      });
    case "verification_completed":
      return appendActivity(
        {
          ...state,
          liveStatusLabel:
            event.verification.status === "failed"
              ? "Verification failed"
              : event.verification.status === "passed"
                ? "Verification passed"
                : "Verification finished",
          verification: event.verification
        },
        {
          bucket: "verification",
          lines: formatVerificationLines(event.verification),
          tone: event.verification.status === "failed" ? "warning" : "success"
        }
      );
    case "assistant_delta":
      return appendAssistantDelta(
        {
          ...state,
          liveStatusLabel: "Responding"
        },
        event.delta
      );
    case "assistant_message":
      return appendSettledAssistantMessage(
        {
          ...state,
          liveStatusLabel: "Responding"
        },
        event.text,
        event.at
      );
    case "run_finished":
      return applyCommandResultToModel(
        {
          ...state,
          liveStatusLabel: null
        },
        event.result
      );
  }
}

export function applyCommandResultToModel(
  state: InteractiveModel,
  result: CommandResult
): InteractiveModel {
  let next: InteractiveModel = {
    ...state,
    approvals: result.approvals,
    artifacts: result.artifacts,
    changedFiles: result.changedFiles,
    context: result.context,
    liveStatusLabel: null,
    pendingApproval: result.pendingApproval,
    plan: result.plan,
    runtimeStatus:
      result.status === "paused" ? "paused" : result.status === "failed" ? "failed" : "completed",
    sessionId: result.sessionId,
    verification: result.verification
  };

  if (result.status === "paused" && result.pendingApproval) {
    next = appendPendingApprovalBlock(
      {
        ...next,
        approvalChoiceIndex: 0,
        liveStatusLabel: "Waiting for approval"
      },
      formatPendingApprovalInfoLines(result.pendingApproval),
      `approval:result:${result.sessionId ?? Date.now()}`
    );
  }

  if (result.status === "failed") {
    next = settleAssistantBlocks(next);
    next = appendSystemLine(next, result.summary, "warning");
  } else if (
    result.status === "completed" &&
    result.summary.trim().length > 0
  ) {
    next = appendFinalAssistantSummary(next, result.summary, `result:${Date.now()}`);
  } else {
    next = settleAssistantBlocks(next);
  }

  return appendCompletionLine(
    {
      ...next,
      scrollOffset: state.scrollOffset
    },
    result
  );
}

function applyStatusEvent(
  state: InteractiveModel,
  event: Extract<RuntimeEvent, { type: "status" }>
): InteractiveModel {
  const next = {
    ...state,
    liveStatusLabel: liveStatusLabelForRuntimeStatus(event.status, event.detail, state.cwd),
    runtimeStatus: event.status
  };

  if (!event.detail || shouldHideStatusDetail(event.detail)) {
    return next;
  }

  return appendSystemLine(next, normalizeInlineText(event.detail, state.cwd), "dim");
}

function applyToolResultEvent(
  state: InteractiveModel,
  event: Extract<RuntimeEvent, { type: "tool_result" }>
): InteractiveModel {
  const next = {
    ...state,
    artifacts: event.artifacts ? mergeArtifacts(state.artifacts, event.artifacts) : state.artifacts,
    changedFiles: event.changedFiles
      ? [...new Set([...state.changedFiles, ...event.changedFiles])].sort()
      : state.changedFiles,
    liveStatusLabel: event.error ? "Tool error" : state.liveStatusLabel
  };

  if (!event.error && event.tool !== "apply_patch" && event.tool !== "run_shell") {
    return next;
  }

  return appendActivity(next, toolResultToActivity(event, state.cwd));
}

function appendSystemLine(
  state: InteractiveModel,
  line: string,
  tone: BlockTone
): InteractiveModel {
  const last = state.blocks.at(-1);
  if (last?.kind === "system" && last.lines.length === 1 && last.lines[0] === line && last.tone === tone) {
    return state;
  }

  return {
    ...state,
    blocks: [
      ...state.blocks,
      {
        id: `system:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        kind: "system",
        lines: [line],
        tone
      }
    ],
    scrollOffset: state.scrollOffset
  };
}

export function appendApprovalResolutionFeedback(
  state: InteractiveModel,
  status: "approved" | "rejected"
): InteractiveModel {
  return appendSystemLine(
    {
      ...state,
      liveStatusLabel: status === "approved" ? "Approval granted" : "Approval rejected",
      pendingApproval: null
    },
    `Approval ${status}.`,
    status === "approved" ? "success" : "warning"
  );
}

function appendActivity(
  state: InteractiveModel,
  activity: {
    bucket: TranscriptBlock["bucket"];
    lines: string[];
    tone: BlockTone;
  }
): InteractiveModel {
  const last = state.blocks.at(-1);
  if (
    last &&
    last.kind === "activity" &&
    last.bucket === activity.bucket &&
    last.lines.length + activity.lines.length <= groupedActivityLineLimit(activity.bucket ?? "explore")
  ) {
    return {
      ...state,
      blocks: [
        ...state.blocks.slice(0, -1),
        {
          ...last,
          lines: dedupeTrailingLines([...last.lines, ...activity.lines]),
          tone: activity.tone === "warning" ? "warning" : last.tone
        }
      ],
      scrollOffset: state.scrollOffset
    };
  }

  return {
    ...state,
    blocks: [
      ...state.blocks,
      {
        bucket: activity.bucket,
        id: `activity:${activity.bucket}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        kind: "activity",
        lines: dedupeTrailingLines(activity.lines),
        tone: activity.tone
      }
    ],
    scrollOffset: state.scrollOffset
  };
}

function appendAssistantDelta(state: InteractiveModel, delta: string): InteractiveModel {
  const last = state.blocks.at(-1);

  if (last?.kind === "assistant") {
    const currentText = last.lines.join("\n");
    return {
      ...state,
      blocks: [
        ...state.blocks.slice(0, -1),
        {
          ...last,
          lines: `${currentText}${delta}`.split("\n"),
          streaming: true
        }
      ],
      scrollOffset: state.scrollOffset
    };
  }

  return {
    ...state,
    blocks: [
      ...state.blocks,
      {
        id: `assistant:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        kind: "assistant",
        lines: delta.split("\n"),
        streaming: true,
        tone: "default"
      }
    ],
    scrollOffset: state.scrollOffset
  };
}

function appendSettledAssistantMessage(
  state: InteractiveModel,
  text: string,
  suffix: string
): InteractiveModel {
  const last = state.blocks.at(-1);
  if (last?.kind === "assistant" && last.streaming) {
    return {
      ...state,
      blocks: [
        ...state.blocks.slice(0, -1),
        {
          id: `assistant:${suffix}`,
          kind: "assistant",
          lines: text.split("\n"),
          streaming: false,
          tone: "default"
        }
      ],
      scrollOffset: state.scrollOffset
    };
  }

  const settled = settleAssistantBlocks(state);
  return {
    ...settled,
    blocks: [
      ...settled.blocks,
      {
        id: `assistant:${suffix}`,
        kind: "assistant",
        lines: text.split("\n"),
        streaming: false,
        tone: "default"
      }
    ],
    scrollOffset: settled.scrollOffset
  };
}

function settleAssistantBlocks(state: InteractiveModel): InteractiveModel {
  let changed = false;
  const blocks = state.blocks.map((block) => {
    if (block.kind === "assistant" && block.streaming) {
      changed = true;
      return {
        ...block,
        streaming: false
      };
    }

    return block;
  });

  return changed
    ? {
        ...state,
        blocks
      }
    : state;
}

function appendCompletionLine(state: InteractiveModel, result: CommandResult): InteractiveModel {
  const line =
    result.status === "completed"
      ? result.verification.status === "passed"
        ? "Completed. Verification passed."
        : result.verification.status === "not_run"
          ? "Completed."
          : "Completed with verification issues."
      : result.status === "failed"
        ? "Run failed."
        : null;

  if (!line) {
    return state;
  }

  const last = state.blocks.at(-1);
  if (last?.kind === "system" && last.lines[0] === line) {
    return state;
  }

  return appendSystemLine(
    state,
    line,
    result.status === "completed" && result.verification.status !== "failed" ? "success" : "warning"
  );
}

function appendPendingApprovalBlock(
  state: InteractiveModel,
  lines: string[],
  id: string
): InteractiveModel {
  if (hasApprovalBlock(state, lines)) {
    return state;
  }

  return {
    ...state,
    blocks: [
      ...state.blocks,
      {
        id,
        kind: "approval",
        lines,
        tone: "warning"
      }
    ],
    scrollOffset: state.scrollOffset
  };
}

function appendFinalAssistantSummary(
  state: InteractiveModel,
  text: string,
  suffix: string
): InteractiveModel {
  const summaryText = summarizeForInteractiveTranscript(text);
  const settled = removeTrailingCompletionSystemLine(settleAssistantBlocks(state));
  const lastAssistantIndex = findLastAssistantIndex(settled);
  const lastText =
    lastAssistantIndex >= 0 ? settled.blocks[lastAssistantIndex]?.lines.join("\n").trim() ?? null : null;
  const shouldReplaceLastAssistant =
    lastAssistantIndex >= 0 &&
    lastText !== null &&
    (summaryText === lastText ||
      summaryText.startsWith(lastText) ||
      lastText.startsWith(summaryText));

  const blocks = shouldReplaceLastAssistant
    ? [
        ...settled.blocks.slice(0, lastAssistantIndex),
        ...settled.blocks.slice(lastAssistantIndex + 1)
      ]
    : settled.blocks;
  const lastBlock = blocks.at(-1);

  if (lastBlock?.kind === "assistant" && lastBlock.lines.join("\n").trim() === summaryText.trim()) {
    return {
      ...settled,
      blocks
    };
  }

  return {
    ...settled,
    blocks: [
      ...blocks,
      {
        id: `assistant:${suffix}`,
        kind: "assistant",
        lines: summaryText.split("\n"),
        streaming: false,
        tone: "default"
      }
    ]
  };
}

function toolCalledToActivity(
  tool: Exclude<ToolName, "write_plan">,
  inputSummary: string,
  cwd: string
): {
  bucket: TranscriptBlock["bucket"];
  lines: string[];
  tone: BlockTone;
} {
  const input = parseToolSummary(inputSummary);

  switch (tool) {
    case "read_file":
      return {
        bucket: "explore",
        lines: [`Read ${normalizeDisplayPath(readPathFromSummary(input), cwd)}`],
        tone: "default"
      };
    case "list_files":
      return {
        bucket: "explore",
        lines: [`Listed ${normalizeDisplayPath(readPathFromSummary(input) ?? ".", cwd)}`],
        tone: "default"
      };
    case "search_files": {
      const query = typeof input?.query === "string" ? input.query : "pattern";
      return {
        bucket: "explore",
        lines: [
          `Searched ${JSON.stringify(query)} in ${normalizeDisplayPath(readPathFromSummary(input) ?? ".", cwd)}`
        ],
        tone: "default"
      };
    }
    case "apply_patch": {
      const count = Array.isArray(input?.operations) ? input.operations.length : 0;
      return {
        bucket: "edit",
        lines: [count > 0 ? `Prepared ${count} patch change${count === 1 ? "" : "s"}` : "Prepared patch"],
        tone: "default"
      };
    }
    case "run_shell": {
      const command = typeof input?.command === "string" ? input.command : inputSummary;
      return {
        bucket: "command",
        lines: [`$ ${normalizeInlineText(command, cwd)}`],
        tone: "default"
      };
    }
  }
}

function toolResultToActivity(
  event: Extract<RuntimeEvent, { type: "tool_result" }>,
  cwd: string
): {
  bucket: TranscriptBlock["bucket"];
  lines: string[];
  tone: BlockTone;
} {
  if (event.error) {
    return {
      bucket: event.tool === "run_shell" ? "command" : event.tool === "apply_patch" ? "edit" : "explore",
      lines: [normalizeInlineText(event.error, cwd)],
      tone: "warning"
    };
  }

  if (event.tool === "apply_patch") {
    const changedFiles = event.changedFiles?.map((path) => normalizeDisplayPath(path, cwd)) ?? [];
    return {
      bucket: "edit",
      lines:
        changedFiles.length === 0
          ? ["Patch applied"]
          : changedFiles.length <= 4
            ? [`Updated ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}`, ...changedFiles]
            : [`Updated ${changedFiles.length} files`, ...changedFiles.slice(0, 3), `+${changedFiles.length - 3} more`],
      tone: "success"
    };
  }

  return {
    bucket: "command",
    lines: formatShellResultLines(event, cwd),
    tone: "default"
  };
}

function liveStatusLabelForTool(tool: Exclude<ToolName, "write_plan">, inputSummary: string, cwd: string): string {
  const input = parseToolSummary(inputSummary);

  switch (tool) {
    case "read_file":
      return `Reading ${normalizeDisplayPath(readPathFromSummary(input), cwd)}`;
    case "list_files":
      return `Listing ${normalizeDisplayPath(readPathFromSummary(input) ?? ".", cwd)}`;
    case "search_files": {
      const query = typeof input?.query === "string" ? input.query : "files";
      return `Searching ${JSON.stringify(query)}`;
    }
    case "apply_patch":
      return "Applying changes";
    case "run_shell": {
      const command = typeof input?.command === "string" ? input.command : "command";
      return `Running ${normalizeInlineText(command, cwd)}`;
    }
  }
}

function liveStatusLabelForRuntimeStatus(
  status: InteractiveModel["runtimeStatus"],
  detail: string | undefined,
  cwd: string
): string | null {
  if (detail && !shouldHideStatusDetail(detail)) {
    return normalizeInlineText(detail, cwd);
  }

  switch (status) {
    case "planning":
      return "Thinking";
    case "reading":
      return "Reading files";
    case "editing":
      return "Applying changes";
    case "verifying":
      return "Running verification";
    case "resuming":
      return "Resuming session";
    case "paused":
      return "Waiting for approval";
    case "completed":
    case "failed":
    case "idle":
      return null;
  }
}

function formatVerificationLines(
  verification: NonNullable<InteractiveModel["verification"]>
): string[] {
  const lines: string[] = [];
  const passedCount = verification.runs.filter((run) => run.passed).length;
  const failedCount = verification.runs.length - passedCount;
  const skippedCount = verification.skippedCommands.length;

  if (verification.status === "passed") {
    lines.push(`Passed ${passedCount} verification command${passedCount === 1 ? "" : "s"}`);
  } else if (verification.status === "failed") {
    lines.push(`Failed ${failedCount} of ${verification.runs.length} verification command${verification.runs.length === 1 ? "" : "s"}`);
  } else if (verification.notRunReason) {
    lines.push(verification.notRunReason);
  }

  if (verification.runs.length > 0) {
    lines.push(
      ...verification.runs.map((run) =>
        `${run.passed ? "[pass]" : "[fail]"} ${run.command} (exit ${run.exitCode})`
      )
    );

    if (!verification.passed) {
      const failingRun = verification.runs.find((run) => !run.passed);
      const excerpt = firstNonEmptyLine(failingRun?.stderr) ?? firstNonEmptyLine(failingRun?.stdout);
      if (excerpt) {
        lines.push(`Output: ${excerpt}`);
      }
    }
  }

  if (skippedCount > 0) {
    lines.push(
      ...verification.skippedCommands.map((item) => `Skipped ${item.command} (${item.reason})`)
    );
  }

  return lines.length > 0 ? lines : ["No verification commands ran."];
}

function formatApprovalLines(
  approval: Approval,
  pendingAction: {
    action: { command?: string; operations?: unknown[] };
    tool: "apply_patch" | "run_shell";
  }
): string[] {
  const lines = [approval.summary];

  if (pendingAction.tool === "run_shell" && pendingAction.action.command) {
    lines.push(`Command: ${pendingAction.action.command}`);
  }

  if (pendingAction.tool === "apply_patch") {
    lines.push(`Patch operations: ${pendingAction.action.operations?.length ?? 0}`);
  }

  return lines;
}

function formatPendingApprovalInfoLines(pendingApproval: PendingApprovalInfo): string[] {
  const lines = [pendingApproval.summary];

  if (pendingApproval.tool === "run_shell" && pendingApproval.command) {
    lines.push(`Command: ${pendingApproval.command}`);
  }

  if (pendingApproval.tool === "apply_patch") {
    lines.push(`Patch operations: ${pendingApproval.operationCount}`);
  }

  return lines;
}

function formatVerificationStartLines(commands: string[]): string[] {
  if (commands.length === 0) {
    return ["No verification commands selected."];
  }

  return commands.length <= 3
    ? [`Running ${commands.length} verification command${commands.length === 1 ? "" : "s"}`, ...commands]
    : [`Running ${commands.length} verification commands`, ...commands.slice(0, 2), `+${commands.length - 2} more`];
}

function formatPlanItemLine(item: PlanState["items"][number]): string {
  const marker =
    item.status === "completed" ? "[done]" : item.status === "in_progress" ? "[doing]" : "[todo]";
  return `${marker} ${item.content}`;
}

function formatShellResultLines(
  event: Extract<RuntimeEvent, { type: "tool_result" }>,
  cwd: string
): string[] {
  const summary = event.observation?.query ? `$ ${normalizeInlineText(event.observation.query, cwd)}` : "Command completed.";
  const excerpt = firstNonEmptyLine(event.observation?.excerpt);
  return excerpt ? [summary, `Output: ${normalizeInlineText(excerpt, cwd)}`] : [summary];
}

function toPendingApproval(
  approval: Approval,
  pendingAction: {
    action: { command?: string; operations?: unknown[] };
    tool: "apply_patch" | "run_shell";
  }
): PendingApprovalInfo {
  return {
    actionClass: approval.actionClass,
    ...(pendingAction.tool === "run_shell"
      ? { command: pendingAction.action.command }
      : { operationCount: pendingAction.action.operations?.length ?? 0 }),
    reason: approval.reason,
    summary: approval.summary,
    tool: pendingAction.tool
  };
}

function upsertApproval(approvals: Approval[], approval: Approval): Approval[] {
  return [...approvals.filter((item) => item.id !== approval.id), approval];
}

function mergeArtifacts(current: Artifact[], next: Artifact[]): Artifact[] {
  const map = new Map(current.map((artifact) => [artifact.path, artifact]));
  for (const artifact of next) {
    map.set(artifact.path, artifact);
  }
  return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function lastAssistantText(state: InteractiveModel): string | null {
  const block = [...state.blocks].reverse().find((item) => item.kind === "assistant");
  return block ? block.lines.join("\n").trim() : null;
}

function hasApprovalBlock(state: InteractiveModel, lines: string[]): boolean {
  return state.blocks.some(
    (block) =>
      block.kind === "approval" &&
      block.lines.length === lines.length &&
      block.lines.every((line, index) => line === lines[index])
  );
}

function findLastAssistantIndex(state: InteractiveModel): number {
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    if (state.blocks[index]?.kind === "assistant") {
      return index;
    }
  }

  return -1;
}

function removeTrailingCompletionSystemLine(state: InteractiveModel): InteractiveModel {
  const last = state.blocks.at(-1);
  if (!last?.kind || last.kind !== "system") {
    return state;
  }

  if (!isCompletionSystemLine(last.lines[0] ?? "")) {
    return state;
  }

  return {
    ...state,
    blocks: state.blocks.slice(0, -1)
  };
}

function isCompletionSystemLine(line: string): boolean {
  return (
    line === "Completed." ||
    line === "Completed. Verification passed." ||
    line === "Completed with verification issues." ||
    line === "Run failed."
  );
}

function summarizeForInteractiveTranscript(text: string): string {
  const sections = text.trim().split(/\n\s*\n/);
  return sections[0]?.trim() || text.trim();
}

function groupedActivityLineLimit(bucket: NonNullable<TranscriptBlock["bucket"]>): number {
  if (bucket === "explore") {
    return 16;
  }
  if (bucket === "command" || bucket === "verification") {
    return 10;
  }
  return 12;
}

function shouldHideStatusDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("preparing model loop") ||
    normalized.includes("collecting repo context") ||
    normalized.includes("waiting for tool result")
  );
}

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
}

function dedupeTrailingLines(lines: string[]): string[] {
  return lines.filter((line, index) => line !== lines[index - 1]);
}

function parseToolSummary(inputSummary: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(inputSummary);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readPathFromSummary(input: Record<string, unknown> | null): string | null {
  if (!input) {
    return null;
  }

  return typeof input.path === "string" ? input.path : null;
}

function normalizeDisplayPath(path: string | null | undefined, cwd: string): string {
  if (!path || path === cwd) {
    return ".";
  }

  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function normalizeInlineText(text: string, cwd: string): string {
  return text.split(cwd).join(".");
}
