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
    transcript: [
      {
        body:
          args.recentSessions.length > 0
            ? "Type a new task or press Enter to resume the selected recent session."
            : "Type a task and press Enter to start.",
        id: "welcome",
        kind: "system",
        title: "Welcome"
      }
    ],
    transcriptScroll: 0,
    verification: null
  };
}

export function applyRuntimeEvent(state: InteractiveState, event: RuntimeEvent): InteractiveState {
  switch (event.type) {
    case "status":
      return {
        ...state,
        footerMessage: event.detail ?? state.footerMessage,
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
      return {
        ...state,
        ...withTranscriptEntry(state, {
          body: event.inputSummary,
          id: `${event.type}:${event.at}`,
          kind: "tool",
          title: `[${event.tool}]`
        })
      };
    case "tool_result": {
      const detailParts = [
        event.observation?.excerpt,
        event.error,
        event.artifacts?.map((artifact) => artifact.diff).join("\n\n")
      ].filter(Boolean);
      return {
        ...state,
        artifacts: event.artifacts ? mergeArtifacts(state.artifacts, event.artifacts) : state.artifacts,
        changedFiles: event.changedFiles ? [...new Set([...state.changedFiles, ...event.changedFiles])].sort() : state.changedFiles,
        ...withTranscriptEntry(state, {
          body:
            event.error ??
            event.observation?.summary ??
            (event.changedFiles && event.changedFiles.length > 0
              ? `Changed: ${event.changedFiles.join(", ")}`
              : "Completed."),
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
          : "Ready for the next task.",
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
