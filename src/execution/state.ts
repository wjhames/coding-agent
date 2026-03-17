import type {
  Approval,
  Artifact,
  ContextSnapshot,
  ExecutionSnapshot,
  GuidanceSummary,
  Observation,
  PlanState,
  RepoContextSummary,
  ToolName,
  TurnRecord,
  VerificationSummary
} from "../runtime/contracts.js";
import type { PendingAction } from "../app/approval.js";
import type { RepoContext } from "../app/context.js";
import {
  dedupeArtifacts,
  emptyContextSnapshot,
  emptyVerificationSummary,
  normalizePaths,
  upsertApproval
} from "../session/aggregate.js";

export interface ExecutionState {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: Set<string>;
  context: ContextSnapshot;
  guidance: GuidanceSummary;
  observations: Observation[];
  pendingAction: PendingAction | null;
  plan: PlanState | null;
  turnChangedFiles: Set<string>;
  turns: TurnRecord[];
  verification: VerificationSummary;
}

export function createExecutionState(source: {
  approvals?: Approval[];
  artifacts?: Artifact[];
  changedFiles?: string[];
  context?: ContextSnapshot;
  guidance: GuidanceSummary;
  observations?: Observation[];
  pendingAction?: PendingAction | null;
  plan?: PlanState | null;
  turns?: TurnRecord[];
  verification?: VerificationSummary;
}): ExecutionState {
  return {
    approvals: source.approvals ?? [],
    artifacts: source.artifacts ?? [],
    changedFiles: new Set(source.changedFiles ?? []),
    context: source.context ?? emptyContextSnapshot(),
    guidance: source.guidance,
    observations: source.observations ?? [],
    pendingAction: source.pendingAction ?? null,
    plan: source.plan ?? null,
    turnChangedFiles: new Set<string>(),
    turns: source.turns ?? [],
    verification: source.verification ?? emptyVerificationSummary()
  };
}

export function toExecutionSnapshot(state: ExecutionState): ExecutionSnapshot {
  return {
    approvals: state.approvals,
    artifacts: state.artifacts,
    changedFiles: changedFilesList(state),
    nextActions: deriveNextActions(state.plan),
    observations: state.observations,
    pendingAction: state.pendingAction,
    plan: state.plan,
    verification: state.verification
  };
}

export function addChangedFiles(state: ExecutionState, files: string[]): void {
  for (const file of files) {
    state.changedFiles.add(file);
    state.turnChangedFiles.add(file);
  }
}

export function addArtifacts(state: ExecutionState, artifacts: Artifact[]): void {
  state.artifacts = dedupeArtifacts([...state.artifacts, ...artifacts]);
}

export function addApproval(state: ExecutionState, approval: Approval): void {
  state.approvals = upsertApproval(state.approvals, approval);
}

export function addObservation(state: ExecutionState, observation: Observation): void {
  state.observations.push(observation);
}

export function setContextSnapshot(state: ExecutionState, context: ContextSnapshot): void {
  state.context = context;
}

export function changedFilesList(state: ExecutionState): string[] {
  return normalizePaths([...state.changedFiles]);
}

export function turnChangedFilesList(state: ExecutionState): string[] {
  return normalizePaths([...state.turnChangedFiles]);
}

export function resetTurnChangedFiles(state: ExecutionState): void {
  state.turnChangedFiles.clear();
}

export function deriveNextActions(plan: PlanState | null): string[] {
  if (!plan) {
    return [];
  }

  return plan.items
    .filter((item) => item.status !== "completed")
    .map((item) => item.content);
}

export function serializePlan(plan: PlanState): string {
  return `${plan.summary} | ${plan.items
    .map((item) => `[${item.status}] ${item.content}`)
    .join(" ; ")}`;
}

export function toRepoContextSummary(repoContext: RepoContext): RepoContextSummary {
  return {
    guidanceFiles: repoContext.guidanceFiles,
    isGitRepo: repoContext.isGitRepo,
    packageScripts: repoContext.packageScripts,
    topLevelEntries: repoContext.topLevelEntries
  };
}

export function recordUserTurn(state: ExecutionState, text: string, at?: string): void {
  state.turns.push({
    at: at ?? new Date().toISOString(),
    id: createTurnId("user"),
    kind: "user",
    text
  });
}

export function recordAssistantTurn(state: ExecutionState, text: string, at?: string): void {
  if (text.trim().length === 0) {
    return;
  }

  state.turns.push({
    at: at ?? new Date().toISOString(),
    id: createTurnId("assistant"),
    kind: "assistant",
    text
  });
}

export function recordSystemNote(state: ExecutionState, text: string, at?: string): void {
  if (text.trim().length === 0) {
    return;
  }

  state.turns.push({
    at: at ?? new Date().toISOString(),
    id: createTurnId("system"),
    kind: "system_note",
    text
  });
}

export function recordToolCallTurn(
  state: ExecutionState,
  inputSummary: string,
  tool: ToolName,
  at?: string
): void {
  state.turns.push({
    at: at ?? new Date().toISOString(),
    id: createTurnId("tool"),
    inputSummary,
    kind: "tool_call",
    tool
  });
}

export function recordToolResultTurn(args: {
  changedFiles?: string[];
  error?: string | null;
  paths?: string[];
  state: ExecutionState;
  summary: string;
  tool: ToolName;
  at?: string;
}): void {
  args.state.turns.push({
    at: args.at ?? new Date().toISOString(),
    changedFiles: normalizePaths(args.changedFiles ?? []),
    error: args.error ?? null,
    id: createTurnId("tool"),
    kind: "tool_result",
    paths: normalizePaths(args.paths ?? []),
    summary: args.summary,
    tool: args.tool
  });
}

export function buildFinalSummary(
  summary: string,
  details: {
    changedFiles: string[];
    verification: VerificationSummary;
  }
): string {
  const lines = [summary];

  if (details.changedFiles.length > 0) {
    lines.push(`Changed files: ${details.changedFiles.join(", ")}`);
  }

  if (details.verification.status === "passed") {
    lines.push(`Verification passed: ${details.verification.runs.map((run) => run.command).join(", ")}`);
  } else if (details.verification.status === "failed") {
    lines.push(
      `Verification failed: ${details.verification.runs
        .filter((run) => !run.passed)
        .map((run) => run.command)
        .join(", ")}`
    );
  } else if (details.verification.notRunReason) {
    lines.push(`Verification not run: ${details.verification.notRunReason}`);
  }

  if (details.verification.skippedCommands.length > 0) {
    lines.push(
      `Verification skipped: ${details.verification.skippedCommands
        .map((item) => `${item.command} (${item.reason})`)
        .join(", ")}`
    );
  }

  return lines.join("\n\n");
}

function createTurnId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}
