import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
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
} from "../cli/output.js";
import type { SessionRecord } from "./store.js";
import { ensureSessionRoot, getSessionEventsFilePath } from "./paths.js";

const sessionConfigSchema = z
  .object({
    approvalPolicy: z.enum(["auto", "prompt", "never"]).optional(),
    baseUrl: z.string().url().optional(),
    maxSteps: z.number().int().positive().optional(),
    model: z.string().optional(),
    networkEgress: z.boolean().optional(),
    profileName: z.string().optional(),
    timeout: z.string().optional()
  })
  .strict();
const planStateSchema = z.object({
  summary: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"])
    })
  )
});
const repoContextSchema = z.object({
  guidanceFiles: z.array(z.string()),
  isGitRepo: z.boolean(),
  topLevelEntries: z.array(z.string())
});
const observationSchema = z.object({
  excerpt: z.string(),
  path: z.string().optional(),
  query: z.string().optional(),
  summary: z.string(),
  tool: z.enum(["apply_patch", "list_files", "read_file", "run_shell", "search_files"])
});
const artifactSchema = z.object({
  diff: z.string(),
  kind: z.literal("diff"),
  path: z.string()
});
const approvalSchema = z.object({
  command: z.string().optional(),
  id: z.string(),
  reason: z.string(),
  status: z.enum(["approved", "pending", "rejected"]),
  summary: z.string(),
  tool: z.enum(["apply_patch", "run_shell"])
});
const patchReplaceSchema = z.object({
  newText: z.string(),
  oldText: z.string(),
  path: z.string(),
  type: z.literal("replace")
});
const patchCreateSchema = z.object({
  content: z.string(),
  path: z.string(),
  type: z.literal("create")
});
const patchDeleteSchema = z.object({
  path: z.string(),
  type: z.literal("delete")
});
const pendingPatchSchema = z.object({
  approval: approvalSchema,
  action: z.object({
    operations: z.array(z.discriminatedUnion("type", [patchReplaceSchema, patchCreateSchema, patchDeleteSchema]))
  }),
  tool: z.literal("apply_patch")
});
const pendingShellSchema = z.object({
  approval: approvalSchema,
  action: z.object({
    command: z.string(),
    justification: z.string().optional()
  }),
  tool: z.literal("run_shell")
});
const verificationRunSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  stderr: z.string(),
  stdout: z.string()
});
const verificationSchema = z
  .object({
    commands: z.array(z.string()),
    inferred: z.boolean(),
    notRunReason: z.string().nullable().optional(),
    passed: z.boolean(),
    ran: z.boolean().optional(),
    runs: z.array(verificationRunSchema),
    status: z.enum(["failed", "not_run", "passed"]).optional()
  })
  .transform((value) => ({
    ...value,
    notRunReason: value.notRunReason ?? null,
    ran: value.ran ?? value.runs.length > 0,
    status:
      value.status ??
      (value.runs.length === 0 ? "not_run" : value.passed ? "passed" : "failed")
  }));
const guidanceSummarySchema = z.object({
  activeRules: z.array(z.string()),
  sources: z.array(
    z.object({
      path: z.string(),
      priority: z.number().int(),
      source: z.enum(["home", "repo", "task"])
    })
  )
});
const memoryEntrySchema = z.object({
  createdAt: z.string(),
  evidence: z.array(z.string()),
  kind: z.enum(["artifact", "decision", "working"]),
  relevance: z.enum(["high", "medium", "low"]),
  summary: z.string()
});
const memorySummarySchema = z.object({
  artifacts: z.array(memoryEntrySchema),
  decisions: z.array(memoryEntrySchema),
  working: z.array(memoryEntrySchema)
});
const compactionSummarySchema = z.object({
  changedFilesSummary: z.string().nullable(),
  eventSummary: z.string().nullable(),
  observationSummary: z.string().nullable(),
  verificationSummary: z.string().nullable()
});

const sessionStartedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    config: sessionConfigSchema,
    cwd: z.string(),
    guidance: guidanceSummarySchema,
    id: z.string(),
    mode: z.enum(["interactive", "exec"]),
    prompt: z.string(),
    repoContext: repoContextSchema
  }),
  eventId: z.string(),
  type: z.literal("session_started")
});
const planUpdatedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    plan: planStateSchema.nullable()
  }),
  eventId: z.string(),
  type: z.literal("plan_updated")
});
const toolCalledEventSchema = z.object({
  at: z.string(),
  data: z.object({
    inputSummary: z.string(),
    tool: z.enum(["apply_patch", "list_files", "read_file", "run_shell", "search_files", "write_plan"])
  }),
  eventId: z.string(),
  type: z.literal("tool_called")
});
const toolResultRecordedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    artifacts: z.array(artifactSchema).optional(),
    changedFiles: z.array(z.string()).optional(),
    observation: observationSchema.optional(),
    tool: z.enum(["apply_patch", "list_files", "read_file", "run_shell", "search_files", "write_plan"])
  }),
  eventId: z.string(),
  type: z.literal("tool_result_recorded")
});
const approvalRequestedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    approval: approvalSchema,
    pendingAction: z.union([pendingPatchSchema, pendingShellSchema])
  }),
  eventId: z.string(),
  type: z.literal("approval_requested")
});
const approvalResolvedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    approvalId: z.string(),
    status: z.enum(["approved", "rejected"])
  }),
  eventId: z.string(),
  type: z.literal("approval_resolved")
});
const memoryUpdatedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    memory: memorySummarySchema
  }),
  eventId: z.string(),
  type: z.literal("memory_updated")
});
const compactionUpdatedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    compaction: compactionSummarySchema
  }),
  eventId: z.string(),
  type: z.literal("compaction_updated")
});
const verificationStartedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    commands: z.array(z.string())
  }),
  eventId: z.string(),
  type: z.literal("verification_started")
});
const verificationCompletedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    verification: verificationSchema
  }),
  eventId: z.string(),
  type: z.literal("verification_completed")
});
const summaryUpdatedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    nextActions: z.array(z.string()),
    summary: z.string()
  }),
  eventId: z.string(),
  type: z.literal("summary_updated")
});
const statusEventBaseSchema = z.object({
  approvals: z.array(approvalSchema),
  artifacts: z.array(artifactSchema),
  changedFiles: z.array(z.string()),
  pendingAction: z.union([pendingPatchSchema, pendingShellSchema]).nullable(),
  verification: verificationSchema
});
const sessionPausedEventSchema = z.object({
  at: z.string(),
  data: statusEventBaseSchema.extend({
    summary: z.string()
  }),
  eventId: z.string(),
  type: z.literal("session_paused")
});
const sessionCompletedEventSchema = z.object({
  at: z.string(),
  data: statusEventBaseSchema.extend({
    summary: z.string()
  }),
  eventId: z.string(),
  type: z.literal("session_completed")
});
const sessionFailedEventSchema = z.object({
  at: z.string(),
  data: statusEventBaseSchema.extend({
    summary: z.string()
  }),
  eventId: z.string(),
  type: z.literal("session_failed")
});

export const sessionEventSchema = z.discriminatedUnion("type", [
  sessionStartedEventSchema,
  planUpdatedEventSchema,
  toolCalledEventSchema,
  toolResultRecordedEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  memoryUpdatedEventSchema,
  compactionUpdatedEventSchema,
  verificationStartedEventSchema,
  verificationCompletedEventSchema,
  summaryUpdatedEventSchema,
  sessionPausedEventSchema,
  sessionCompletedEventSchema,
  sessionFailedEventSchema
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export function createSessionStartedEvent(input: {
  config: SessionRecord["config"];
  cwd: string;
  guidance: GuidanceSummary;
  id: string;
  mode: SessionRecord["mode"];
  prompt: string;
  repoContext: RepoContextSummary;
}): SessionEvent {
  return createEvent("session_started", input);
}

export function createPlanUpdatedEvent(plan: PlanState | null): SessionEvent {
  return createEvent("plan_updated", { plan });
}

export function createToolCalledEvent(input: {
  inputSummary: string;
  tool: "apply_patch" | "list_files" | "read_file" | "run_shell" | "search_files" | "write_plan";
}): SessionEvent {
  return createEvent("tool_called", input);
}

export function createToolResultRecordedEvent(input: {
  artifacts?: Artifact[];
  changedFiles?: string[];
  observation?: Observation;
  tool: "apply_patch" | "list_files" | "read_file" | "run_shell" | "search_files" | "write_plan";
}): SessionEvent {
  return createEvent("tool_result_recorded", input);
}

export function createApprovalRequestedEvent(input: {
  approval: Approval;
  pendingAction: SessionRecord["pendingAction"];
}): SessionEvent {
  if (input.pendingAction === null) {
    throw new Error("Approval requested event requires a pending action.");
  }

  return createEvent("approval_requested", input as {
    approval: Approval;
    pendingAction: NonNullable<SessionRecord["pendingAction"]>;
  });
}

export function createApprovalResolvedEvent(input: {
  approvalId: string;
  status: "approved" | "rejected";
}): SessionEvent {
  return createEvent("approval_resolved", input);
}

export function createMemoryUpdatedEvent(memory: MemorySummary): SessionEvent {
  return createEvent("memory_updated", { memory });
}

export function createCompactionUpdatedEvent(compaction: CompactionSummary): SessionEvent {
  return createEvent("compaction_updated", { compaction });
}

export function createVerificationStartedEvent(commands: string[]): SessionEvent {
  return createEvent("verification_started", { commands });
}

export function createVerificationCompletedEvent(
  verification: VerificationSummary
): SessionEvent {
  return createEvent("verification_completed", { verification });
}

export function createSummaryUpdatedEvent(input: {
  nextActions: string[];
  summary: string;
}): SessionEvent {
  return createEvent("summary_updated", input);
}

export function createSessionPausedEvent(input: {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: string[];
  pendingAction: SessionRecord["pendingAction"];
  summary: string;
  verification: VerificationSummary;
}): SessionEvent {
  return createEvent("session_paused", input);
}

export function createSessionCompletedEvent(input: {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: string[];
  pendingAction: SessionRecord["pendingAction"];
  summary: string;
  verification: VerificationSummary;
}): SessionEvent {
  return createEvent("session_completed", input);
}

export function createSessionFailedEvent(input: {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: string[];
  pendingAction: SessionRecord["pendingAction"];
  summary: string;
  verification: VerificationSummary;
}): SessionEvent {
  return createEvent("session_failed", input);
}

function createEvent<TType extends SessionEvent["type"]>(
  type: TType,
  data: Extract<SessionEvent, { type: TType }>["data"]
): SessionEvent {
  return {
    at: new Date().toISOString(),
    data,
    eventId: randomUUID(),
    type
  } as Extract<SessionEvent, { type: TType }>;
}

export async function appendSessionEvents(
  sessionId: string,
  events: SessionEvent[],
  homeDir?: string
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await ensureSessionRoot(homeDir);
  const path = getSessionEventsFilePath(sessionId, homeDir);
  const body = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await appendFile(path, body, "utf8");
}

export async function loadSessionEvents(
  sessionId: string,
  homeDir?: string
): Promise<SessionEvent[]> {
  const path = getSessionEventsFilePath(sessionId, homeDir);

  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => sessionEventSchema.parse(JSON.parse(line)));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

export function reduceSessionEvents(events: SessionEvent[]): SessionRecord | null {
  if (events.length === 0) {
    return null;
  }

  const first = events[0]!;

  if (first.type !== "session_started") {
    throw new Error("Session event log must start with session_started.");
  }

  let session: SessionRecord = {
    approvals: [],
    artifacts: [],
    changedFiles: [],
    compaction: {
      changedFilesSummary: null,
      eventSummary: null,
      observationSummary: null,
      verificationSummary: null
    },
    config: first.data.config,
    createdAt: first.at,
    cwd: first.data.cwd,
    eventCount: 0,
    guidance: first.data.guidance,
    id: first.data.id,
    lastEventAt: null,
    memory: {
      artifacts: [],
      decisions: [],
      working: []
    },
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
    verification: {
      commands: [],
      inferred: false,
      notRunReason: null,
      passed: false,
      ran: false,
      runs: [],
      status: "not_run"
    }
  };

  for (const event of events) {
    session = reduceSingleEvent(session, event, events.length);
  }

  return session;
}

function reduceSingleEvent(
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
        next.changedFiles = [...new Set([...next.changedFiles, ...event.data.changedFiles])].sort();
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
      next.changedFiles = [...new Set(event.data.changedFiles)].sort();
      next.pendingAction = event.data.pendingAction;
      next.status = "paused";
      next.summary = event.data.summary;
      next.verification = event.data.verification;
      return next;
    case "session_completed":
      next.approvals = event.data.approvals;
      next.artifacts = event.data.artifacts;
      next.changedFiles = [...new Set(event.data.changedFiles)].sort();
      next.pendingAction = event.data.pendingAction;
      next.status = "completed";
      next.summary = event.data.summary;
      next.verification = event.data.verification;
      return next;
    case "session_failed":
      next.approvals = event.data.approvals;
      next.artifacts = event.data.artifacts;
      next.changedFiles = [...new Set(event.data.changedFiles)].sort();
      next.pendingAction = event.data.pendingAction;
      next.status = "failed";
      next.summary = event.data.summary;
      next.verification = event.data.verification;
      return next;
  }
}

function upsertApproval(approvals: Approval[], approval: Approval): Approval[] {
  return [...approvals.filter((item) => item.id !== approval.id), approval];
}

function dedupeArtifacts(artifacts: Artifact[]): Artifact[] {
  const map = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
}
