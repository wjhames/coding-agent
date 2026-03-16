import type {
  Approval,
  Artifact,
  CompactionSummary,
  GuidanceSummary,
  MemorySummary,
  Observation,
  PlanState,
  RepoContextSummary,
  VerificationSummary
} from "../runtime/contracts.js";
import type { PendingAction } from "../app/approval.js";
import { deriveCompaction } from "../app/compaction.js";
import type { RepoContext } from "../app/context.js";
import { deriveMemory } from "../app/memory.js";
import { createCompactionUpdatedEvent, createMemoryUpdatedEvent, type SessionEvent } from "../session/events.js";
import {
  dedupeArtifacts,
  emptyCompactionSummary,
  emptyMemorySummary,
  upsertApproval
} from "../session/aggregate.js";

export interface ExecutionState {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: Set<string>;
  compaction: CompactionSummary;
  events: SessionEvent[];
  guidance: GuidanceSummary;
  memory: MemorySummary;
  observations: Observation[];
  pendingAction: PendingAction | null;
  plan: PlanState | null;
  verification: VerificationSummary;
}

export function createExecutionState(source: {
  approvals?: Approval[];
  artifacts?: Artifact[];
  changedFiles?: string[];
  compaction?: CompactionSummary;
  guidance: GuidanceSummary;
  memory?: MemorySummary;
  observations?: Observation[];
  pendingAction?: PendingAction | null;
  plan?: PlanState | null;
  verification: VerificationSummary;
}): ExecutionState {
  return {
    approvals: source.approvals ?? [],
    artifacts: source.artifacts ?? [],
    changedFiles: new Set(source.changedFiles ?? []),
    compaction: source.compaction ?? emptyCompactionSummary(),
    events: [],
    guidance: source.guidance,
    memory: source.memory ?? emptyMemorySummary(),
    observations: source.observations ?? [],
    pendingAction: source.pendingAction ?? null,
    plan: source.plan ?? null,
    verification: source.verification
  };
}

export function addChangedFiles(state: ExecutionState, files: string[]): void {
  for (const file of files) {
    state.changedFiles.add(file);
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

export function syncDerivedState(state: ExecutionState): void {
  syncMemory(state);
  syncCompaction(state);
}

export function changedFilesList(state: ExecutionState): string[] {
  return [...state.changedFiles];
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
    topLevelEntries: repoContext.topLevelEntries
  };
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

function syncMemory(state: ExecutionState): void {
  const nextMemory = deriveMemory({
    approvals: state.approvals,
    artifacts: state.artifacts,
    changedFiles: changedFilesList(state),
    observations: state.observations,
    plan: state.plan,
    verification: state.verification
  });

  if (JSON.stringify(state.memory) === JSON.stringify(nextMemory)) {
    return;
  }

  state.memory = nextMemory;
  state.events.push(createMemoryUpdatedEvent(nextMemory));
}

function syncCompaction(state: ExecutionState): void {
  const nextCompaction = deriveCompaction({
    changedFiles: changedFilesList(state),
    events: state.events,
    observations: state.observations,
    verification: state.verification
  });

  if (JSON.stringify(state.compaction) === JSON.stringify(nextCompaction)) {
    return;
  }

  state.compaction = nextCompaction;
  state.events.push(createCompactionUpdatedEvent(nextCompaction));
}
