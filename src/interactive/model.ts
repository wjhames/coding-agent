import type {
  Approval,
  Artifact,
  CommandResult,
  PendingApprovalInfo,
  PlanState,
  RuntimeEvent,
  ToolName,
  VerificationSummary
} from "../cli/output.js";
import type { RuntimeDoctor } from "../runtime/api.js";
import type { SessionRecord } from "../session/store.js";

const CONTEXT_BUDGET_CHARS = 18_000;
const MAX_GROUPED_ACTIVITY_LINES = 12;
const BLANK_RENDER_LINE = " ";
const LIVE_EDGE_BOTTOM_ALIGN_THRESHOLD = 0.75;
const PAGE_SCROLL_STEP = 18;
const LINE_SCROLL_STEP = 4;

type ActivityBucket = "command" | "edit" | "explore" | "plan" | "verification";
type BlockTone = "default" | "dim" | "success" | "warning";

export interface QueuedPrompt {
  id: string;
  prompt: string;
}

export interface TranscriptBlock {
  bucket?: ActivityBucket | undefined;
  id: string;
  kind: "activity" | "approval" | "assistant" | "system" | "user";
  lines: string[];
  queued?: boolean | undefined;
  tone: BlockTone;
}

export interface RenderLine {
  backgroundColor?: string | undefined;
  bold?: boolean | undefined;
  color?: string | undefined;
  dimColor?: boolean | undefined;
  text: string;
}

export interface InteractiveModel {
  approvalChoiceIndex: number;
  approvals: Approval[];
  artifacts: Artifact[];
  blocks: TranscriptBlock[];
  changedFiles: string[];
  cwd: string;
  doctor: RuntimeDoctor | null;
  input: string;
  pendingApproval: PendingApprovalInfo | null;
  plan: PlanState | null;
  profileName: string | null;
  queuedPrompts: QueuedPrompt[];
  recentSessions: SessionRecord[];
  runtimeStatus:
    | "completed"
    | "editing"
    | "failed"
    | "idle"
    | "paused"
    | "planning"
    | "reading"
    | "resuming"
    | "verifying";
  scrollOffset: number;
  sessionId: string | null;
  verification: VerificationSummary | null;
}

export function createInteractiveModel(args: {
  cwd: string;
  doctor: RuntimeDoctor | null;
  recentSessions: SessionRecord[];
}): InteractiveModel {
  return {
    approvalChoiceIndex: 0,
    approvals: [],
    artifacts: [],
    blocks: [],
    changedFiles: [],
    cwd: args.cwd,
    doctor: args.doctor,
    input: "",
    pendingApproval: null,
    plan: null,
    profileName: args.doctor?.defaultProfile ?? null,
    queuedPrompts: [],
    recentSessions: args.recentSessions,
    runtimeStatus: "idle",
    scrollOffset: 0,
    sessionId: null,
    verification: null
  };
}

export function setInteractiveInput(state: InteractiveModel, value: string): InteractiveModel {
  return {
    ...state,
    input: value
  };
}

export function appendInteractiveInput(state: InteractiveModel, value: string): InteractiveModel {
  return {
    ...state,
    input: `${state.input}${value}`
  };
}

export function trimInteractiveInput(state: InteractiveModel): InteractiveModel {
  return {
    ...state,
    input: state.input.slice(0, -1)
  };
}

export function insertInteractiveLineBreak(state: InteractiveModel): InteractiveModel {
  return {
    ...state,
    input: `${state.input}\n`
  };
}

export function scrollInteractiveViewport(
  state: InteractiveModel,
  direction: "down" | "end" | "page_down" | "page_up" | "top" | "up"
): InteractiveModel {
  const delta =
    direction === "up"
      ? LINE_SCROLL_STEP
      : direction === "down"
        ? -LINE_SCROLL_STEP
        : direction === "page_up"
          ? PAGE_SCROLL_STEP
          : direction === "page_down"
            ? -PAGE_SCROLL_STEP
            : 0;

  return {
    ...state,
    scrollOffset:
      direction === "end"
        ? 0
        : direction === "top"
          ? Number.MAX_SAFE_INTEGER
          : Math.max(0, state.scrollOffset + delta)
  };
}

export function toggleApprovalChoice(state: InteractiveModel): InteractiveModel {
  return {
    ...state,
    approvalChoiceIndex: state.approvalChoiceIndex === 0 ? 1 : 0
  };
}

export function enqueuePrompt(state: InteractiveModel, prompt: string): {
  promptId: string;
  state: InteractiveModel;
} {
  const promptId = `prompt:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  const queued = isRunActive(state) || state.pendingApproval !== null;

  return {
    promptId,
    state: {
      ...state,
      blocks: [
        ...state.blocks,
        {
          id: promptId,
          kind: "user",
          lines: [prompt],
          queued,
          tone: "default"
        }
      ],
      input: "",
      queuedPrompts: queued ? [...state.queuedPrompts, { id: promptId, prompt }] : state.queuedPrompts,
      scrollOffset: 0
    }
  };
}

export function beginPromptRun(state: InteractiveModel, promptId: string): InteractiveModel {
  return {
    ...state,
    blocks: state.blocks.map((block) =>
      block.id === promptId
        ? {
            ...block,
            lines: block.lines.map((line) => line.replace(/ \(queued\)$/, "")),
            queued: false
          }
        : block
    ),
    queuedPrompts: state.queuedPrompts.filter((entry) => entry.id !== promptId),
    runtimeStatus: "planning",
    scrollOffset: 0
  };
}

export function nextQueuedPrompt(state: InteractiveModel): QueuedPrompt | null {
  return state.queuedPrompts[0] ?? null;
}

export function refreshRecentSessions(
  state: InteractiveModel,
  recentSessions: SessionRecord[]
): InteractiveModel {
  return {
    ...state,
    recentSessions
  };
}

export function applyRuntimeEventToModel(
  state: InteractiveModel,
  event: RuntimeEvent
): InteractiveModel {
  switch (event.type) {
    case "status":
      return applyStatusEvent(state, event);
    case "plan_updated":
      return event.plan
        ? appendActivity(
            {
              ...state,
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
        ? state
        : appendActivity(state, toolCalledToActivity(event.tool, event.inputSummary, state.cwd));
    case "tool_result":
      return applyToolResultEvent(state, event);
    case "approval_requested":
      return {
        ...state,
        approvalChoiceIndex: 0,
        pendingApproval: toPendingApproval(event.approval, event.pendingAction),
        runtimeStatus: "paused",
        approvals: upsertApproval(state.approvals, event.approval),
        blocks: [
          ...state.blocks,
          {
            id: `approval:${event.at}`,
            kind: "approval",
            lines: formatApprovalLines(event.approval, event.pendingAction),
            tone: "warning"
          }
        ],
        scrollOffset: state.scrollOffset
      };
    case "approval_resolved":
      return appendSystemLine(
        {
          ...state,
          pendingApproval: null
        },
        `Approval ${event.status}.`,
        event.status === "approved" ? "success" : "warning"
      );
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
          verification: event.verification
        },
        {
          bucket: "verification",
          lines: formatVerificationLines(event.verification),
          tone: event.verification.status === "failed" ? "warning" : "success"
        }
      );
    case "assistant_delta":
      return appendAssistantDelta(state, event.delta);
    case "assistant_message":
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            id: `assistant:${event.at}`,
            kind: "assistant",
            lines: event.text.split("\n"),
            tone: "default"
          }
        ],
        scrollOffset: state.scrollOffset
      };
    case "run_finished":
      return applyCommandResultToModel(state, event.result);
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
    pendingApproval: result.pendingApproval,
    plan: result.plan,
    runtimeStatus:
      result.status === "paused" ? "paused" : result.status === "failed" ? "failed" : "completed",
    sessionId: result.sessionId,
    verification: result.verification
  };

  if (result.status === "failed") {
    next = appendSystemLine(next, result.summary, "warning");
  } else if (
    result.status === "completed" &&
    result.summary.trim().length > 0 &&
    lastAssistantText(next) === null
  ) {
    next = {
      ...next,
      blocks: [
        ...next.blocks,
        {
          id: `assistant:result:${Date.now()}`,
          kind: "assistant",
          lines: result.summary.split("\n"),
          tone: "default"
        }
      ]
    };
  }

  return appendCompletionLine(
    {
      ...next,
      scrollOffset: state.scrollOffset
    },
    result
  );
}

export function buildViewportLines(args: {
  columns: number;
  model: InteractiveModel;
  rows: number;
}): RenderLine[] {
  const width = Math.max(40, args.columns);
  const full = buildFullRenderLines(args.model, width);
  const visibleHeight = Math.max(6, args.rows);
  const start = Math.max(0, full.length - visibleHeight - args.model.scrollOffset);
  const end = Math.min(full.length, start + visibleHeight);
  const viewport = full.slice(start, end);
  const shouldBottomAlign =
    viewport.length < visibleHeight &&
    args.model.blocks.length > 0 &&
    args.model.scrollOffset === 0 &&
    full.length >= Math.ceil(visibleHeight * LIVE_EDGE_BOTTOM_ALIGN_THRESHOLD);

  return shouldBottomAlign
    ? padViewportTop(viewport, visibleHeight)
    : viewport;
}

export function reconcileViewportScroll(
  current: InteractiveModel,
  next: InteractiveModel,
  columns: number
): InteractiveModel {
  if (current.scrollOffset === 0 || next.scrollOffset !== current.scrollOffset) {
    return next;
  }

  const width = Math.max(40, columns);
  const delta = buildFullRenderLines(next, width).length - buildFullRenderLines(current, width).length;
  if (delta <= 0) {
    return next;
  }

  return {
    ...next,
    scrollOffset: current.scrollOffset + delta
  };
}

export function estimateContextLeftPercent(state: InteractiveModel): number {
  const used = [
    state.blocks.flatMap((block) => block.lines).join("\n"),
    state.input,
    state.plan?.summary ?? "",
    state.verification?.runs.map((run) => run.command).join("\n") ?? ""
  ].join("\n").length;

  return Math.max(1, Math.min(99, Math.round((1 - used / CONTEXT_BUDGET_CHARS) * 100)));
}

function applyStatusEvent(
  state: InteractiveModel,
  event: Extract<RuntimeEvent, { type: "status" }>
): InteractiveModel {
  const next = {
    ...state,
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
      : state.changedFiles
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

function appendActivity(
  state: InteractiveModel,
  activity: {
    bucket: ActivityBucket;
    lines: string[];
    tone: BlockTone;
  }
): InteractiveModel {
  const last = state.blocks.at(-1);
  if (
    last &&
    last.kind === "activity" &&
    last.bucket === activity.bucket &&
    last.lines.length + activity.lines.length <= groupedActivityLineLimit(activity.bucket)
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
          lines: `${currentText}${delta}`.split("\n")
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
        tone: "default"
      }
    ],
    scrollOffset: state.scrollOffset
  };
}

function buildFullRenderLines(model: InteractiveModel, width: number): RenderLine[] {
  const transcriptLines = compactBlankLines(
    model.blocks.flatMap((block) =>
      renderBlock(block, {
        approvalChoiceIndex: model.approvalChoiceIndex,
        pendingApproval: model.pendingApproval,
        width
      })
    )
  );
  const composerLines = renderComposer(model, width, transcriptLines.length > 0);
  return [...transcriptLines, ...composerLines];
}

function renderBlock(
  block: TranscriptBlock,
  args: {
    approvalChoiceIndex: number;
    pendingApproval: PendingApprovalInfo | null;
    width: number;
  }
): RenderLine[] {
  if (block.kind === "user") {
    return [
      ...wrapForRender(block.lines.join("\n"), args.width - 4).map((line) => ({
        backgroundColor: block.queued ? "#26292d" : "#2f3338",
        color: block.queued ? "#b8bec5" : "#f5f5f5",
        text: ` ${padLine(block.queued && line === block.lines[0] ? `Queued: ${line}` : line, args.width - 2)} `
      })),
      { text: BLANK_RENDER_LINE }
    ];
  }

  if (block.kind === "assistant") {
    return renderAssistantBlock(block, args.width);
  }

  if (block.kind === "system") {
    return [
      ...wrapForRender(block.lines.join("\n"), args.width).map((line) => ({
        dimColor: block.tone === "dim",
        text: line
      })),
      { text: BLANK_RENDER_LINE }
    ];
  }

  if (block.kind === "approval") {
    const options =
      args.pendingApproval && block.id === findLastApprovalId(block.id, args.pendingApproval)
        ? [
            args.approvalChoiceIndex === 0 ? "[Approve once]" : " Approve once ",
            args.approvalChoiceIndex === 1 ? "[Reject]" : " Reject "
          ].join("  ")
        : null;
    return renderApprovalBlock(block, args.width, options);
  }

  return renderLabeledBlock(block, args.width, activityTitle(block), []);
}

function renderLabeledBlock(
  block: TranscriptBlock,
  width: number,
  title: string,
  trailingLines: string[]
): RenderLine[] {
  const lines: RenderLine[] = [
    {
      bold: true,
      color: toneColor(block.tone),
      text: `• ${title}`
    } as RenderLine
  ];

  for (const rawLine of [...block.lines, ...trailingLines]) {
    for (const line of wrapForRender(rawLine, width - 2)) {
      lines.push({
        color: toneColor(block.tone),
        dimColor: block.tone === "dim",
        text: `  ${line}`
      });
    }
  }

  lines.push({ text: BLANK_RENDER_LINE });
  return lines;
}

function renderApprovalBlock(
  block: TranscriptBlock,
  width: number,
  options: string | null
): RenderLine[] {
  const lines: RenderLine[] = [
    {
      bold: true,
      color: "yellow",
      text: "• Approval needed"
    }
  ];

  for (const rawLine of [...block.lines, ...(options ? [options] : [])]) {
    for (const line of wrapForRender(rawLine, width - 4)) {
      lines.push({
        backgroundColor: "#332500",
        color: "#f7d774",
        text: ` ${padLine(line, width - 2)} `
      });
    }
  }

  lines.push({ text: BLANK_RENDER_LINE });
  return lines;
}

function renderAssistantBlock(block: TranscriptBlock, width: number): RenderLine[] {
  const lines: RenderLine[] = [];
  let inCodeBlock = false;

  for (const rawLine of block.lines) {
    if (rawLine.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      lines.push({
        dimColor: true,
        text: "─".repeat(Math.max(12, Math.min(width, 40)))
      });
      continue;
    }

    const rendered = renderAssistantContentLine(rawLine, width, inCodeBlock);
    lines.push(...rendered);
  }

  lines.push({ text: BLANK_RENDER_LINE });
  return lines;
}

function renderComposer(state: InteractiveModel, width: number, hasTranscript: boolean): RenderLine[] {
  const placeholder =
    state.pendingApproval !== null && state.input.length === 0
      ? "Type to queue the next prompt. Enter approves the selected action."
      : state.queuedPrompts.length > 0 && state.input.length === 0
        ? `Queue next prompt (${state.queuedPrompts.length} waiting)`
      : state.recentSessions.length > 0 && state.blocks.length === 0 && state.input.length === 0
        ? "Type a task. Press Enter on empty input to resume the latest session."
        : "Type a task";
  const inputBody = state.input.length > 0 ? state.input : placeholder;
  const inputLines = wrapForRender(inputBody, width - 10);

  const rendered = [
    ...inputLines.map((line, index) => ({
      backgroundColor: "#25282d",
      color: state.input.length > 0 ? "#f5f5f5" : "#9aa1a8",
      text: `    ${padLine(index === inputLines.length - 1 ? `${line}${state.input.length > 0 ? "█" : ""}` : line, width - 8)}    `
    })),
    {
      dimColor: true,
      text: `${state.doctor?.model ?? state.profileName ?? "model"} - ${estimateContextLeftPercent(
        state
      )}% context left - ${state.cwd}`
    }
  ];

  return hasTranscript ? [{ text: BLANK_RENDER_LINE }, ...rendered] : rendered;
}

function compactBlankLines(lines: RenderLine[]): RenderLine[] {
  const compacted: RenderLine[] = [];

  for (const line of lines) {
    const isBlank = line.text.trim().length === 0;
    const previous = compacted.at(-1);
    if (isBlank && previous && previous.text.trim().length === 0) {
      continue;
    }
    compacted.push(isBlank ? { ...line, text: BLANK_RENDER_LINE } : line);
  }

  while (compacted.at(-1)?.text.trim().length === 0) {
    compacted.pop();
  }

  return compacted;
}

function padViewportTop(lines: RenderLine[], height: number): RenderLine[] {
  if (lines.length >= height) {
    return lines;
  }

  return [
    ...Array.from({ length: height - lines.length }, () => ({ text: BLANK_RENDER_LINE })),
    ...lines
  ];
}

function toolCalledToActivity(
  tool: Exclude<ToolName, "write_plan">,
  inputSummary: string,
  cwd: string
): {
  bucket: ActivityBucket;
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
    default:
      return {
        bucket: "explore",
        lines: [normalizeInlineText(inputSummary, cwd)],
        tone: "default"
      };
  }
}

function toolResultToActivity(
  event: Extract<RuntimeEvent, { type: "tool_result" }>,
  cwd: string
): {
  bucket: ActivityBucket;
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

function formatVerificationLines(verification: VerificationSummary): string[] {
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

function activityTitle(block: TranscriptBlock): string {
  if (block.bucket === "verification") {
    return block.tone === "warning" ? "Verification failed" : block.tone === "success" ? "Verification passed" : "Verification";
  }
  if (block.bucket === "plan") {
    return "Plan update";
  }
  if (block.bucket === "command") {
    return block.lines.length > 1 ? `Ran ${block.lines.length} commands` : "Ran command";
  }
  if (block.bucket === "edit") {
    return block.lines.length > 1 ? `Edited ${block.lines.length - 1} files` : "Edited";
  }
  return block.lines.length > 1 ? `Explored ${block.lines.length} items` : "Explored";
}

function groupedActivityLineLimit(bucket: ActivityBucket): number {
  if (bucket === "explore") {
    return 16;
  }
  if (bucket === "command" || bucket === "verification") {
    return 10;
  }
  return MAX_GROUPED_ACTIVITY_LINES;
}

function formatPlanItemLine(item: PlanState["items"][number]): string {
  const marker =
    item.status === "completed" ? "[done]" : item.status === "in_progress" ? "[doing]" : "[todo]";
  return `${marker} ${item.content}`;
}

function formatApprovalLines(
  approval: Approval,
  pendingAction: {
    action: { command?: string; operations?: unknown[] };
    tool: "apply_patch" | "run_shell";
  }
): string[] {
  const lines = [
    approval.summary,
    `Tool: ${pendingAction.tool}`,
    `Class: ${approval.actionClass}`,
    `Reason: ${approval.reason}`
  ];

  if (pendingAction.tool === "run_shell" && pendingAction.action.command) {
    lines.push(`Command: ${pendingAction.action.command}`);
  }

  if (pendingAction.tool === "apply_patch") {
    lines.push(`Patch operations: ${pendingAction.action.operations?.length ?? 0}`);
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

function appendCompletionLine(state: InteractiveModel, result: CommandResult): InteractiveModel {
  const line =
    result.status === "completed"
      ? result.verification.status === "passed"
        ? `Completed. Verification passed.`
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

function formatShellResultLines(
  event: Extract<RuntimeEvent, { type: "tool_result" }>,
  cwd: string
): string[] {
  const summary = event.observation?.query ? `$ ${normalizeInlineText(event.observation.query, cwd)}` : "Command completed.";
  const excerpt = firstNonEmptyLine(event.observation?.excerpt);
  return excerpt ? [summary, `Output: ${normalizeInlineText(excerpt, cwd)}`] : [summary];
}

function renderAssistantContentLine(
  rawLine: string,
  width: number,
  inCodeBlock: boolean
): RenderLine[] {
  if (inCodeBlock) {
    return wrapForRender(rawLine, width).map((line) => ({
      color: "#c7d4ff",
      text: `  ${line}`
    }));
  }

  const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    return wrapForRender(headingMatch[2] || "", width).map((line) => ({
      bold: true,
      text: line
    }));
  }

  const quoteMatch = rawLine.match(/^>\s?(.*)$/);
  if (quoteMatch) {
    return wrapForRender(quoteMatch[1] || "", width - 2).map((line) => ({
      dimColor: true,
      text: `> ${line}`
    }));
  }

  const bulletMatch = rawLine.match(/^(\s*(?:[-*]|\d+[.)]))\s+(.*)$/);
  if (bulletMatch) {
    return wrapWithPrefix(bulletMatch[2] || "", width, `${bulletMatch[1]} `, " ".repeat((bulletMatch[1] ?? "").length + 1)).map((line) => ({
      text: line
    }));
  }

  return wrapForRender(rawLine, width).map((line) => ({ text: line }));
}

function wrapWithPrefix(text: string, width: number, firstPrefix: string, restPrefix: string): string[] {
  const availableFirst = Math.max(8, width - firstPrefix.length);
  const availableRest = Math.max(8, width - restPrefix.length);
  const parts = wrapForRender(text, availableFirst);

  if (parts.length <= 1) {
    return [`${firstPrefix}${parts[0] ?? ""}`];
  }

  const [first, ...rest] = parts;
  return [
    `${firstPrefix}${first}`,
    ...rest.flatMap((line) => wrapForRender(line, availableRest).map((wrapped) => `${restPrefix}${wrapped}`))
  ];
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

function findLastApprovalId(id: string, pendingApproval: PendingApprovalInfo): string {
  void pendingApproval;
  return id;
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

function isRunActive(state: InteractiveModel): boolean {
  return (
    state.runtimeStatus === "planning" ||
    state.runtimeStatus === "reading" ||
    state.runtimeStatus === "editing" ||
    state.runtimeStatus === "verifying" ||
    state.runtimeStatus === "resuming"
  );
}

function lastAssistantText(state: InteractiveModel): string | null {
  const block = [...state.blocks].reverse().find((item) => item.kind === "assistant");
  return block ? block.lines.join("\n").trim() : null;
}

function shouldHideStatusDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("preparing model loop") ||
    normalized.includes("collecting repo context") ||
    normalized.includes("waiting for tool result")
  );
}

function wrapForRender(text: string, width: number): string[] {
  const source = text.length > 0 ? text : " ";
  const lines = source.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    if (line.length <= width) {
      output.push(line);
      continue;
    }

    let remaining = line;
    while (remaining.length > width) {
      const candidate = remaining.slice(0, width + 1);
      const breakAt = candidate.lastIndexOf(" ");
      const splitAt = breakAt > Math.floor(width * 0.5) ? breakAt : width;
      output.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.length > 0) {
      output.push(remaining);
    }
  }

  return output;
}

function padLine(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : `${text}${" ".repeat(width - text.length)}`;
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

function toneColor(tone: BlockTone): string | undefined {
  if (tone === "warning") {
    return "yellow";
  }
  if (tone === "success") {
    return "green";
  }
  if (tone === "dim") {
    return "#9aa1a8";
  }
  return undefined;
}
