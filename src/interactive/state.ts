import type {
  Approval,
  Artifact,
  PendingApprovalInfo,
  PlanState,
  VerificationSummary
} from "../runtime/contracts.js";
import type { RuntimeDoctor } from "../runtime/api.js";
import type { SessionRecord } from "../session/store.js";

const PAGE_SCROLL_STEP = 18;
const LINE_SCROLL_STEP = 4;

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
  streaming?: boolean | undefined;
  tone: BlockTone;
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
  liveStatusLabel: string | null;
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

export type ActivityBucket = "command" | "edit" | "explore" | "plan" | "verification";
export type BlockTone = "default" | "dim" | "success" | "warning";

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
    liveStatusLabel: null,
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
      liveStatusLabel: queued ? state.liveStatusLabel : "Thinking",
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
    liveStatusLabel: "Thinking",
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

export function isRunActive(state: InteractiveModel): boolean {
  return (
    state.runtimeStatus === "planning" ||
    state.runtimeStatus === "reading" ||
    state.runtimeStatus === "editing" ||
    state.runtimeStatus === "verifying" ||
    state.runtimeStatus === "resuming"
  );
}
