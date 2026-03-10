import type {
  Approval,
  Artifact,
  CommandResult,
  PendingApprovalInfo,
  PlanState,
  RuntimeEvent,
  VerificationSummary
} from "../cli/output.js";
import type { RuntimeDoctor } from "../runtime/api.js";
import type { SessionRecord } from "../session/store.js";

export interface TranscriptEntry {
  body: string;
  detail?: string | undefined;
  id: string;
  kind:
    | "approval"
    | "assistant"
    | "plan"
    | "status"
    | "system"
    | "tool"
    | "user"
    | "verification";
  title: string;
}

export interface InteractiveState {
  approvalChoiceIndex: number;
  artifacts: Artifact[];
  changedFiles: string[];
  currentRun: Promise<void> | null;
  cwd: string;
  detailScroll: number;
  doctor: RuntimeDoctor | null;
  footerMessage: string | null;
  input: string;
  mode: "approval" | "details" | "home" | "running";
  pendingApproval: PendingApprovalInfo | null;
  plan: PlanState | null;
  profileName: string | null;
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
  selectedSessionIndex: number;
  selectedTranscriptIndex: number;
  sessionId: string | null;
  transcript: TranscriptEntry[];
  transcriptScroll: number;
  verification: VerificationSummary | null;
}

export function createInitialInteractiveState(args: {
  cwd: string;
  doctor: RuntimeDoctor | null;
  recentSessions: SessionRecord[];
}): InteractiveState {
  return {
    approvalChoiceIndex: 0,
    artifacts: [],
    changedFiles: [],
    currentRun: null,
    cwd: args.cwd,
    detailScroll: 0,
    doctor: args.doctor,
    footerMessage: null,
    input: "",
    mode: "home",
    pendingApproval: null,
    plan: null,
    profileName: args.doctor?.defaultProfile ?? null,
    recentSessions: args.recentSessions,
    runtimeStatus: "idle",
    selectedSessionIndex: 0,
    selectedTranscriptIndex: 0,
    sessionId: null,
    transcript: [],
    transcriptScroll: 0,
    verification: null
  };
}

export function applyRuntimeEvent(state: InteractiveState, event: RuntimeEvent): InteractiveState {
  switch (event.type) {
    case "status":
      return {
        ...state,
        runtimeStatus: event.status,
        ...(event.detail && event.detail.length > 0
          ? withTranscriptEntry(state, {
                body: event.detail,
                id: `${event.type}:${event.at}`,
                kind: "status",
                title: event.status
              })
          : {})
      };
    case "plan_updated":
      return {
        ...state,
        plan: event.plan,
        ...withTranscriptEntry(state, {
          body: event.plan
            ? event.plan.items.map((item) => `[${item.status}] ${item.content}`).join("\n")
            : "Cleared plan.",
          detail: event.plan ? JSON.stringify(event.plan, null, 2) : undefined,
          id: `${event.type}:${event.at}`,
          kind: "plan",
          title: event.plan ? event.plan.summary : "Plan cleared"
        })
      };
    case "tool_called":
      if (event.tool === "write_plan") {
        return state;
      }
      return {
        ...state,
        ...withTranscriptEntry(state, {
          body: formatToolCall(event.tool, event.inputSummary, state.cwd),
          id: `${event.type}:${event.at}`,
          kind: "tool",
          title: `[${event.tool}]`
        })
      };
    case "tool_result": {
      const shouldStreamResult =
        Boolean(event.error) ||
        event.tool === "apply_patch" ||
        event.tool === "run_shell" ||
        Boolean(event.changedFiles && event.changedFiles.length > 0);
      const detailParts = [
        event.observation?.excerpt,
        event.error,
        event.artifacts?.map((artifact) => artifact.diff).join("\n\n")
      ].filter(Boolean);

      if (!shouldStreamResult) {
        return {
          ...state,
          artifacts: event.artifacts ? mergeArtifacts(state.artifacts, event.artifacts) : state.artifacts,
          changedFiles: event.changedFiles
            ? [...new Set([...state.changedFiles, ...event.changedFiles])].sort()
            : state.changedFiles
        };
      }

      return {
        ...state,
        artifacts: event.artifacts ? mergeArtifacts(state.artifacts, event.artifacts) : state.artifacts,
        changedFiles: event.changedFiles ? [...new Set([...state.changedFiles, ...event.changedFiles])].sort() : state.changedFiles,
        ...withTranscriptEntry(state, {
          body: formatToolResult(event, state.cwd),
          detail: detailParts.length > 0 ? detailParts.join("\n\n") : undefined,
          id: `${event.type}:${event.at}`,
          kind: "tool",
          title: `[${event.tool}] result`
        })
      };
    }
    case "approval_requested":
      return {
        ...state,
        approvalChoiceIndex: 0,
        mode: "approval",
        pendingApproval: toPendingApproval(event.approval, event.pendingAction),
        runtimeStatus: "paused",
        ...withTranscriptEntry(state, {
          body: event.approval.summary,
          detail: JSON.stringify(event.pendingAction, null, 2),
          id: `${event.type}:${event.at}`,
          kind: "approval",
          title: "Approval needed"
        })
      };
    case "approval_resolved":
      return {
        ...state,
        footerMessage: `Approval ${event.status}.`,
        pendingApproval: null,
        ...withTranscriptEntry(state, {
          body: `Approval ${event.status}.`,
          id: `${event.type}:${event.at}`,
          kind: "approval",
          title: "Approval"
        })
      };
    case "verification_started":
      return {
        ...state,
        runtimeStatus: "verifying",
        ...withTranscriptEntry(state, {
          body: event.commands.join("\n"),
          detail: event.commands.join("\n"),
          id: `${event.type}:${event.at}`,
          kind: "verification",
          title: "Verification started"
        })
      };
    case "verification_completed":
      return {
        ...state,
        verification: event.verification,
        ...withTranscriptEntry(state, {
          body: formatVerificationSummary(event.verification),
          detail: JSON.stringify(event.verification, null, 2),
          id: `${event.type}:${event.at}`,
          kind: "verification",
          title: `Verification ${event.verification.status}`
        })
      };
    case "assistant_message":
      return {
        ...state,
        ...withTranscriptEntry(state, {
          body: event.text,
          detail: event.text,
          id: `${event.type}:${event.at}`,
          kind: "assistant",
          title: "Assistant"
        })
      };
    case "run_finished":
      return applyCommandResult(state, event.result);
  }
}

export function applyCommandResult(state: InteractiveState, result: CommandResult): InteractiveState {
  return {
    ...state,
    artifacts: result.artifacts,
    changedFiles: result.changedFiles,
    currentRun: null,
    footerMessage:
      result.status === "paused"
        ? "Approval required."
        : result.status === "failed"
          ? "Run failed."
          : null,
    input: "",
    mode: result.status === "paused" ? "approval" : "home",
    pendingApproval: result.pendingApproval,
    plan: result.plan,
    runtimeStatus:
      result.status === "paused" ? "paused" : result.status === "failed" ? "failed" : "completed",
    sessionId: result.sessionId,
    transcriptScroll: 0,
    verification: result.verification
  };
}

export function appendTranscript(
  transcript: TranscriptEntry[],
  entry: TranscriptEntry
): TranscriptEntry[] {
  return [...transcript, entry];
}

function withTranscriptEntry(
  state: InteractiveState,
  entry: TranscriptEntry
): Pick<InteractiveState, "selectedTranscriptIndex" | "transcript" | "transcriptScroll"> {
  const transcript = appendTranscript(state.transcript, entry);
  return {
    selectedTranscriptIndex: transcript.length - 1,
    transcript,
    transcriptScroll: 0
  };
}

function mergeArtifacts(current: Artifact[], next: Artifact[]): Artifact[] {
  const map = new Map(current.map((artifact) => [artifact.path, artifact]));
  for (const artifact of next) {
    map.set(artifact.path, artifact);
  }
  return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
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

function formatVerificationSummary(verification: VerificationSummary): string {
  const lines = [
    `Status: ${verification.status}`,
    verification.runs.length > 0
      ? `Executed: ${verification.runs.map((run) => run.command).join(", ")}`
      : "Executed: none",
    verification.skippedCommands.length > 0
      ? `Skipped: ${verification.skippedCommands
          .map((item) => `${item.command} (${item.reason})`)
          .join(", ")}`
      : "Skipped: none"
  ];

  if (verification.notRunReason) {
    lines.push(`Reason: ${verification.notRunReason}`);
  }

  return lines.join("\n");
}

function formatToolCall(
  tool: "apply_patch" | "list_files" | "read_file" | "run_shell" | "search_files" | "write_plan",
  inputSummary: string,
  cwd: string
): string {
  const input = parseToolSummary(inputSummary);

  if (tool === "read_file") {
    return `Read ${normalizeDisplayPath(readPathFromSummary(input), cwd)}`;
  }

  if (tool === "list_files") {
    return `List files in ${normalizeDisplayPath(readPathFromSummary(input) ?? ".", cwd)}`;
  }

  if (tool === "search_files") {
    const query = typeof input?.query === "string" ? input.query : "pattern";
    const path = normalizeDisplayPath(readPathFromSummary(input) ?? ".", cwd);
    return `Search ${JSON.stringify(query)} in ${path}`;
  }

  if (tool === "run_shell") {
    const command = typeof input?.command === "string" ? input.command : inputSummary;
    return `$ ${normalizeInlineText(command, cwd)}`;
  }

  if (tool === "apply_patch") {
    const count = Array.isArray(input?.operations) ? input.operations.length : 0;
    return count > 0 ? `Apply patch (${count} operation${count === 1 ? "" : "s"})` : "Apply patch";
  }

  return normalizeInlineText(inputSummary, cwd);
}

function formatToolResult(
  event: {
    changedFiles?: string[] | undefined;
    error?: string | undefined;
    observation?: { summary: string } | undefined;
    tool: "apply_patch" | "list_files" | "read_file" | "run_shell" | "search_files" | "write_plan";
  },
  cwd: string
): string {
  if (event.error) {
    return normalizeInlineText(event.error, cwd);
  }

  if (event.tool === "apply_patch" && event.changedFiles && event.changedFiles.length > 0) {
    return `Changed ${event.changedFiles.map((path) => normalizeDisplayPath(path, cwd)).join(", ")}`;
  }

  if (event.tool === "run_shell" && event.observation?.summary) {
    return normalizeInlineText(event.observation.summary, cwd);
  }

  if (event.changedFiles && event.changedFiles.length > 0) {
    return `Changed ${event.changedFiles.map((path) => normalizeDisplayPath(path, cwd)).join(", ")}`;
  }

  return normalizeInlineText(event.observation?.summary ?? "Completed.", cwd);
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

  if (path.startsWith(`${cwd}/`)) {
    return path.slice(cwd.length + 1);
  }

  return path;
}

function normalizeInlineText(text: string, cwd: string): string {
  return text.split(cwd).join(".");
}
