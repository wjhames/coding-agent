import { z } from "zod";
import {
  approvalSchema,
  artifactSchema,
  contextBudgetSchema,
  contextSnapshotSchema,
  executionSnapshotSchema,
  guidanceSummarySchema,
  planStateSchema,
  repoContextSchema,
  sessionConfigSchema,
  sessionModeSchema,
  sessionStatusSchema,
  turnRecordSchema,
  verificationSchema,
  type Approval,
  type Artifact,
  type ContextSnapshot,
  type ExecutionSnapshot,
  type GuidanceSummary,
  type PlanState,
  type RepoContextSummary,
  type TurnRecord,
  type VerificationSummary
} from "../runtime/contracts.js";

export const sessionRecordSchema = z
  .object({
    config: sessionConfigSchema,
    context: contextSnapshotSchema,
    createdAt: z.string(),
    cwd: z.string(),
    guidance: guidanceSummarySchema,
    id: z.string(),
    mode: sessionModeSchema,
    prompt: z.string(),
    repoContext: repoContextSchema,
    state: executionSnapshotSchema,
    status: sessionStatusSchema,
    summary: z.string(),
    turns: z.array(turnRecordSchema),
    updatedAt: z.string()
  })
  .strict();

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export interface CreateSessionInput {
  config: SessionRecord["config"];
  context?: ContextSnapshot;
  cwd: string;
  guidance?: GuidanceSummary;
  mode: SessionMode;
  prompt: string;
  repoContext: RepoContextSummary;
  state?: Partial<ExecutionSnapshot>;
  status: SessionStatus;
  summary: string;
  turns?: TurnRecord[];
}

export interface UpdateSessionInput {
  config: SessionRecord["config"];
  context: ContextSnapshot;
  cwd: string;
  guidance: GuidanceSummary;
  mode: SessionMode;
  prompt: string;
  repoContext: RepoContextSummary;
  state: ExecutionSnapshot;
  status: SessionStatus;
  summary: string;
  turns: TurnRecord[];
}

export function createSessionRecord(args: {
  id: string;
  input: CreateSessionInput;
  now?: string;
}): SessionRecord {
  const now = args.now ?? new Date().toISOString();

  return {
    config: args.input.config,
    context: args.input.context ?? emptyContextSnapshot(),
    createdAt: now,
    cwd: args.input.cwd,
    guidance: args.input.guidance ?? emptyGuidanceSummary(),
    id: args.id,
    mode: args.input.mode,
    prompt: args.input.prompt,
    repoContext: args.input.repoContext,
    state: normalizeExecutionSnapshot(args.input.state),
    status: args.input.status,
    summary: args.input.summary,
    turns: args.input.turns ?? [],
    updatedAt: now
  };
}

export function updateSessionRecord(
  session: SessionRecord,
  input: UpdateSessionInput,
  now?: string
): SessionRecord {
  return sessionRecordSchema.parse({
    ...session,
    config: input.config,
    context: input.context,
    cwd: input.cwd,
    guidance: input.guidance,
    mode: input.mode,
    prompt: input.prompt,
    repoContext: input.repoContext,
    state: input.state,
    status: input.status,
    summary: input.summary,
    turns: input.turns,
    updatedAt: now ?? new Date().toISOString()
  });
}

export function emptyContextSnapshot(): ContextSnapshot {
  return {
    budget: {
      contextWindowTokens: null,
      droppedSections: [],
      inputTokens: 0,
      outputReserveTokens: 0,
      remainingTokens: null,
      sections: [],
      usedPercent: null
    },
    historySummary: null,
    recentTurnCount: 0,
    snippets: [],
    workingSet: []
  };
}

export function emptyGuidanceSummary(): GuidanceSummary {
  return {
    activeRules: [],
    sources: []
  };
}

export function emptyVerificationSummary(): VerificationSummary {
  return verificationSchema.parse({
    commands: [],
    inferred: true,
    notRunReason: "Verification has not run yet.",
    passed: false,
    runs: []
  });
}

export function dedupeArtifacts(artifacts: Artifact[]): Artifact[] {
  const byPath = new Map<string, Artifact>();

  for (const artifact of artifacts) {
    byPath.set(artifact.path, artifactSchema.parse(artifact));
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function upsertApproval(approvals: Approval[], approval: Approval): Approval[] {
  const next = new Map(approvals.map((item) => [item.id, approvalSchema.parse(item)]));
  next.set(approval.id, approvalSchema.parse(approval));
  return [...next.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function normalizeExecutionSnapshot(
  state: Partial<ExecutionSnapshot> | undefined
): ExecutionSnapshot {
  return executionSnapshotSchema.parse({
    approvals: state?.approvals ?? [],
    artifacts: state?.artifacts ?? [],
    changedFiles: normalizePaths(state?.changedFiles ?? []),
    nextActions: state?.nextActions ?? [],
    observations: state?.observations ?? [],
    pendingAction: state?.pendingAction ?? null,
    plan: state?.plan ?? null,
    verification: state?.verification ?? emptyVerificationSummary()
  });
}

export { contextBudgetSchema, executionSnapshotSchema, planStateSchema };
