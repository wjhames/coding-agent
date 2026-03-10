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
const MAX_GROUPED_ACTIVITY_LINES = 8;

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

export function scrollInteractiveViewport(
  state: InteractiveModel,
  direction: "down" | "end" | "page_down" | "page_up" | "up"
): InteractiveModel {
  const delta =
    direction === "up"
      ? 1
      : direction === "down"
        ? -1
        : direction === "page_up"
          ? 10
          : direction === "page_down"
            ? -10
            : 0;

  return {
    ...state,
    scrollOffset: direction === "end" ? 0 : Math.max(0, state.scrollOffset + delta)
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
          lines: [queued ? `${prompt} (queued)` : prompt],
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
              lines: [
                event.plan.summary,
                ...event.plan.items.map((item) => `[${item.status}] ${item.content}`)
              ],
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
            lines: [event.approval.summary],
            tone: "warning"
          }
        ],
        scrollOffset: 0
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
        lines: event.commands.map((command) => `Run ${command}`),
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
        scrollOffset: 0
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

  return {
    ...next,
    scrollOffset: 0
  };
}

export function buildViewportLines(args: {
  columns: number;
  model: InteractiveModel;
  rows: number;
}): RenderLine[] {
  const width = Math.max(40, args.columns);
  const transcriptLines = compactBlankLines(
    args.model.blocks.flatMap((block) =>
      renderBlock(block, {
        approvalChoiceIndex: args.model.approvalChoiceIndex,
        pendingApproval: args.model.pendingApproval,
        width
      })
    )
  );
  const composerLines = renderComposer(args.model, width, transcriptLines.length > 0);
  const full = [...transcriptLines, ...composerLines];
  const visibleHeight = Math.max(6, args.rows);
  const start = Math.max(0, full.length - visibleHeight - args.model.scrollOffset);
  const end = Math.min(full.length, start + visibleHeight);
  return full.slice(start, end);
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
    scrollOffset: 0
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
    last.lines.length + activity.lines.length <= MAX_GROUPED_ACTIVITY_LINES
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
      scrollOffset: 0
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
    scrollOffset: 0
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
      scrollOffset: 0
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
    scrollOffset: 0
  };
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
        backgroundColor: "#2f3338",
        color: "#f5f5f5",
        text: ` ${padLine(line, args.width - 2)} `
      })),
      { text: "" }
    ];
  }

  if (block.kind === "assistant") {
    return [
      ...wrapForRender(block.lines.join("\n"), args.width).map((line) => ({
        text: line
      })),
      { text: "" }
    ];
  }

  if (block.kind === "system") {
    return [
      ...wrapForRender(block.lines.join("\n"), args.width).map((line) => ({
        dimColor: block.tone === "dim",
        text: line
      })),
      { text: "" }
    ];
  }

  if (block.kind === "approval") {
    const options =
      args.pendingApproval && block.id === findLastApprovalId(block.id, args.pendingApproval)
        ? [
            args.approvalChoiceIndex === 0 ? "[Approve]" : " Approve ",
            args.approvalChoiceIndex === 1 ? "[Reject]" : " Reject "
          ].join("  ")
        : null;
    return renderLabeledBlock(block, args.width, "Approval needed", options ? [options] : []);
  }

  const title =
    block.bucket === "explore"
      ? "Explored"
      : block.bucket === "edit"
        ? "Edited"
        : block.bucket === "command"
          ? "Ran command"
          : block.bucket === "plan"
            ? "Plan"
            : "Verification";
  return renderLabeledBlock(block, args.width, title, []);
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

  lines.push({ text: "" });
  return lines;
}

function renderComposer(state: InteractiveModel, width: number, hasTranscript: boolean): RenderLine[] {
  const placeholder =
    state.pendingApproval !== null && state.input.length === 0
      ? "Enter approves selected action. Type to queue the next prompt."
      : state.recentSessions.length > 0 && state.blocks.length === 0 && state.input.length === 0
        ? "Type a task. Press Enter on empty input to resume the latest session."
        : "Type a task";
  const inputBody = state.input.length > 0 ? state.input : placeholder;
  const inputLines = wrapForRender(inputBody, width - 6);

  const rendered = [
    ...inputLines.map((line, index) => ({
      backgroundColor: "#25282d",
      color: state.input.length > 0 ? "#f5f5f5" : "#9aa1a8",
      text: `  ${padLine(index === inputLines.length - 1 && state.input.length > 0 ? `${line}█` : line, width - 4)}  `
    })),
    {
      dimColor: true,
      text: `${state.doctor?.model ?? state.profileName ?? "model"} - ${estimateContextLeftPercent(
        state
      )}% context left - ${state.cwd}`
    }
  ];

  return hasTranscript ? [{ text: "" }, ...rendered] : rendered;
}

function compactBlankLines(lines: RenderLine[]): RenderLine[] {
  const compacted: RenderLine[] = [];

  for (const line of lines) {
    const isBlank = line.text.length === 0;
    const previous = compacted.at(-1);
    if (isBlank && previous?.text.length === 0) {
      continue;
    }
    compacted.push(line);
  }

  while (compacted.at(-1)?.text.length === 0) {
    compacted.pop();
  }

  return compacted;
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
        lines: [`List files in ${normalizeDisplayPath(readPathFromSummary(input) ?? ".", cwd)}`],
        tone: "default"
      };
    case "search_files": {
      const query = typeof input?.query === "string" ? input.query : "pattern";
      return {
        bucket: "explore",
        lines: [
          `Search ${JSON.stringify(query)} in ${normalizeDisplayPath(readPathFromSummary(input) ?? ".", cwd)}`
        ],
        tone: "default"
      };
    }
    case "apply_patch": {
      const count = Array.isArray(input?.operations) ? input.operations.length : 0;
      return {
        bucket: "edit",
        lines: [count > 0 ? `Apply patch with ${count} change${count === 1 ? "" : "s"}` : "Apply patch"],
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
    return {
      bucket: "edit",
      lines: [
        event.changedFiles && event.changedFiles.length > 0
          ? `Changed ${event.changedFiles.map((path) => normalizeDisplayPath(path, cwd)).join(", ")}`
          : "Patch applied"
      ],
      tone: "success"
    };
  }

  return {
    bucket: "command",
    lines: [normalizeInlineText(event.observation?.summary ?? "Command completed.", cwd)],
    tone: "default"
  };
}

function formatVerificationLines(verification: VerificationSummary): string[] {
  const lines: string[] = [];

  if (verification.runs.length > 0) {
    lines.push(
      ...verification.runs.map((run) =>
        `${run.passed ? "Passed" : "Failed"} ${run.command} (exit ${run.exitCode})`
      )
    );
  }

  if (verification.skippedCommands.length > 0) {
    lines.push(
      ...verification.skippedCommands.map((item) => `Skipped ${item.command} (${item.reason})`)
    );
  }

  if (verification.notRunReason) {
    lines.push(verification.notRunReason);
  }

  return lines.length > 0 ? lines : ["No verification commands ran."];
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
