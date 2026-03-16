import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  approvalSchema,
  artifactSchema,
  compactionSummarySchema,
  guidanceSummarySchema,
  memorySummarySchema,
  observationSchema,
  pendingActionSchema,
  repoContextSchema,
  sessionConfigSchema,
  toolNameSchema,
  type Approval,
  type Artifact,
  type CompactionSummary,
  type GuidanceSummary,
  type MemorySummary,
  type Observation,
  type PlanState,
  type RepoContextSummary,
  type VerificationSummary,
  verificationSchema,
  planStateSchema
} from "../runtime/contracts.js";
import type { SessionRecord } from "./aggregate.js";
import { ensureSessionRoot, getSessionEventsFilePath } from "./paths.js";

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
    tool: toolNameSchema
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
    tool: toolNameSchema
  }),
  eventId: z.string(),
  type: z.literal("tool_result_recorded")
});
const approvalRequestedEventSchema = z.object({
  at: z.string(),
  data: z.object({
    approval: approvalSchema,
    pendingAction: pendingActionSchema
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
  pendingAction: pendingActionSchema.nullable(),
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
