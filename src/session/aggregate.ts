import { z } from "zod";
import {
  approvalSchema,
  artifactSchema,
  compactionSummarySchema,
  guidanceSummarySchema,
  memorySummarySchema,
  observationSchema,
  pendingActionSchema,
  planStateSchema,
  repoContextSchema,
  sessionConfigSchema,
  sessionModeSchema,
  sessionStatusSchema,
  verificationSchema,
  type Approval,
  type Artifact,
  type CompactionSummary,
  type GuidanceSummary,
  type MemorySummary,
  type Observation,
  type PlanState,
  type RepoContextSummary,
  type VerificationSummary
} from "../runtime/contracts.js";
import type { SessionEvent } from "./events.js";

export const sessionRecordSchema = z
  .object({
    approvals: z.array(approvalSchema),
    artifacts: z.array(artifactSchema),
    changedFiles: z.array(z.string()),
    compaction: compactionSummarySchema,
    config: sessionConfigSchema,
    createdAt: z.string(),
    cwd: z.string(),
    eventCount: z.number().int().nonnegative(),
    guidance: guidanceSummarySchema,
    id: z.string(),
    lastEventAt: z.string().nullable(),
    memory: memorySummarySchema,
    mode: sessionModeSchema,
    nextActions: z.array(z.string()),
    observations: z.array(observationSchema),
    pendingAction: pendingActionSchema.nullable(),
    plan: planStateSchema.nullable(),
    prompt: z.string(),
    repoContext: repoContextSchema,
    status: sessionStatusSchema,
    summary: z.string(),
    updatedAt: z.string(),
    verification: verificationSchema
  })
  .strict();

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export interface CreateSessionInput {
  approvals?: Approval[];
  artifacts?: Artifact[];
  changedFiles?: string[];
  compaction?: CompactionSummary;
  config: SessionRecord["config"];
  cwd: string;
  eventCount?: number;
  guidance?: GuidanceSummary;
  mode: SessionMode;
  lastEventAt?: string | null;
  memory?: MemorySummary;
  nextActions?: string[];
  observations?: Observation[];
  pendingAction?: SessionRecord["pendingAction"];
  plan?: PlanState | null;
  prompt: string;
  repoContext: RepoContextSummary;
  status: SessionStatus;
  summary: string;
  verification?: VerificationSummary;
  events?: SessionEvent[];
}

export function createSessionRecord(args: {
  id: string;
  input: CreateSessionInput;
  now?: string;
}): SessionRecord {
  const now = args.now ?? new Date().toISOString();

  return {
    approvals: args.input.approvals ?? [],
    artifacts: args.input.artifacts ?? [],
    changedFiles: args.input.changedFiles ?? [],
    compaction: args.input.compaction ?? emptyCompactionSummary(),
    config: args.input.config,
    createdAt: now,
    cwd: args.input.cwd,
    eventCount: args.input.eventCount ?? 0,
    guidance: args.input.guidance ?? emptyGuidanceSummary(),
    id: args.id,
    lastEventAt: args.input.lastEventAt ?? null,
    memory: args.input.memory ?? emptyMemorySummary(),
    mode: args.input.mode,
    nextActions: args.input.nextActions ?? [],
    observations: args.input.observations ?? [],
    pendingAction: args.input.pendingAction ?? null,
    plan: args.input.plan ?? null,
    prompt: args.input.prompt,
    repoContext: args.input.repoContext,
    status: args.input.status,
    summary: args.input.summary,
    updatedAt: now,
    verification: args.input.verification ?? emptyVerificationSummary()
  };
}

export function reduceSessionEvents(events: SessionEvent[]): SessionRecord | null {
  if (events.length === 0) {
    return null;
  }

  const first = events[0];

  if (!first || first.type !== "session_started") {
    throw new Error("Session event log must start with session_started.");
  }

  let session: SessionRecord = {
    approvals: [],
    artifacts: [],
    changedFiles: [],
    compaction: emptyCompactionSummary(),
    config: first.data.config,
    createdAt: first.at,
    cwd: first.data.cwd,
    eventCount: 0,
    guidance: first.data.guidance,
    id: first.data.id,
    lastEventAt: null,
    memory: emptyMemorySummary(),
    mode: first.data.mode,
    nextActions: [],
    observations: [],
    pendingAction: null,
    plan: null,
    prompt: first.data.prompt,
    repoContext: first.data.repoContext,
    status: "failed",
    summary: "",
    updatedAt: first.at,
    verification: emptyVerificationSummary()
  };

  for (const event of events) {
    session = applySessionEvent(session, event, events.length);
  }

  return session;
}

export function applySessionEvent(
  session: SessionRecord,
  event: SessionEvent,
  eventCount: number
): SessionRecord {
  const next: SessionRecord = {
    ...session,
    eventCount,
    lastEventAt: event.at,
    updatedAt: event.at
  };

  switch (event.type) {
    case "session_started":
      next.config = event.data.config;
      next.cwd = event.data.cwd;
      next.guidance = event.data.guidance;
      next.id = event.data.id;
      next.mode = event.data.mode;
      next.prompt = event.data.prompt;
      next.repoContext = event.data.repoContext;
      next.createdAt = event.at;
      return next;
    case "plan_updated":
      next.plan = event.data.plan;
      return next;
    case "tool_called":
      return next;
    case "tool_result_recorded":
      if (event.data.observation) {
        next.observations = [...next.observations, event.data.observation];
      }
      if (event.data.artifacts) {
        next.artifacts = dedupeArtifacts([...next.artifacts, ...event.data.artifacts]);
      }
      if (event.data.changedFiles) {
        next.changedFiles = normalizePaths([...next.changedFiles, ...event.data.changedFiles]);
      }
      return next;
    case "approval_requested":
      next.pendingAction = event.data.pendingAction;
      next.approvals = upsertApproval(next.approvals, event.data.approval);
      return next;
    case "approval_resolved":
      next.approvals = next.approvals.map((approval) =>
        approval.id === event.data.approvalId
          ? { ...approval, status: event.data.status }
          : approval
      );
      next.pendingAction = null;
      return next;
    case "memory_updated":
      next.memory = event.data.memory;
      return next;
    case "compaction_updated":
      next.compaction = event.data.compaction;
      return next;
    case "verification_started":
      next.verification = {
        ...next.verification,
        commands: event.data.commands
      };
      return next;
    case "verification_completed":
      next.verification = event.data.verification;
      return next;
    case "summary_updated":
      next.nextActions = event.data.nextActions;
      next.summary = event.data.summary;
      return next;
    case "session_paused":
      next.approvals = event.data.approvals;
      next.artifacts = event.data.artifacts;
      next.changedFiles = normalizePaths(event.data.changedFiles);
      next.pendingAction = event.data.pendingAction;
      next.status = "paused";
      next.summary = event.data.summary;
      next.verification = event.data.verification;
      return next;
    case "session_completed":
      next.approvals = event.data.approvals;
      next.artifacts = event.data.artifacts;
      next.changedFiles = normalizePaths(event.data.changedFiles);
      next.pendingAction = event.data.pendingAction;
      next.status = "completed";
      next.summary = event.data.summary;
      next.verification = event.data.verification;
      return next;
    case "session_failed":
      next.approvals = event.data.approvals;
      next.artifacts = event.data.artifacts;
      next.changedFiles = normalizePaths(event.data.changedFiles);
      next.pendingAction = event.data.pendingAction;
      next.status = "failed";
      next.summary = event.data.summary;
      next.verification = event.data.verification;
      return next;
  }
}

export function emptyCompactionSummary(): CompactionSummary {
  return {
    changedFilesSummary: null,
    eventSummary: null,
    observationSummary: null,
    verificationSummary: null
  };
}

export function emptyGuidanceSummary(): GuidanceSummary {
  return {
    activeRules: [],
    sources: []
  };
}

export function emptyMemorySummary(): MemorySummary {
  return {
    artifacts: [],
    decisions: [],
    working: []
  };
}

export function emptyVerificationSummary(): VerificationSummary {
  return {
    commands: [],
    inferred: false,
    notRunReason: null,
    passed: false,
    ran: false,
    runs: [],
    selectedCommands: [],
    skippedCommands: [],
    status: "not_run"
  };
}

export function upsertApproval(approvals: Approval[], approval: Approval): Approval[] {
  return [...approvals.filter((item) => item.id !== approval.id), approval];
}

export function dedupeArtifacts(artifacts: Artifact[]): Artifact[] {
  const map = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}
