import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
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
import {
  appendSessionEvents,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionPausedEvent,
  createSessionStartedEvent,
  createSummaryUpdatedEvent,
  loadSessionEvents,
  reduceSessionEvents,
  type SessionEvent
} from "./events.js";
import { ensureSessionRoot, getSessionFilePath, getSessionRoot } from "./paths.js";

export const sessionStatusSchema = z.enum(["completed", "failed", "paused"]);
export const sessionModeSchema = z.enum(["interactive", "exec"]);
const planItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"])
});
const planStateSchema = z.object({
  summary: z.string(),
  items: z.array(planItemSchema)
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
const verificationSchema = z.object({
  commands: z.array(z.string()),
  inferred: z.boolean(),
  passed: z.boolean(),
  runs: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number().int(),
      passed: z.boolean(),
      stderr: z.string(),
      stdout: z.string()
    })
  )
});
const guidanceSourceSchema = z.object({
  path: z.string(),
  priority: z.number().int(),
  source: z.enum(["home", "repo", "task"])
});
const guidanceSummarySchema = z.object({
  activeRules: z.array(z.string()),
  sources: z.array(guidanceSourceSchema)
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

export const sessionRecordSchema = z
  .object({
    approvals: z.array(approvalSchema),
    artifacts: z.array(artifactSchema),
    changedFiles: z.array(z.string()),
    compaction: compactionSummarySchema,
    config: z
      .object({
        approvalPolicy: z.enum(["auto", "prompt", "never"]).optional(),
        baseUrl: z.string().url().optional(),
        maxSteps: z.number().int().positive().optional(),
        model: z.string().optional(),
        networkEgress: z.boolean().optional(),
        profileName: z.string().optional(),
        timeout: z.string().optional()
      })
      .strict(),
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
    pendingAction: z.union([pendingPatchSchema, pendingShellSchema]).nullable(),
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

export class SessionStoreError extends Error {}

export async function createSession(
  input: CreateSessionInput,
  homeDir?: string
): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const sessionId = randomUUID();
  const session: SessionRecord = {
    approvals: input.approvals ?? [],
    artifacts: input.artifacts ?? [],
    changedFiles: input.changedFiles ?? [],
    compaction: input.compaction ?? {
      changedFilesSummary: null,
      eventSummary: null,
      observationSummary: null,
      verificationSummary: null
    },
    config: input.config,
    createdAt: now,
    cwd: input.cwd,
    eventCount: input.eventCount ?? 0,
    guidance: input.guidance ?? {
      activeRules: [],
      sources: []
    },
    id: sessionId,
    lastEventAt: input.lastEventAt ?? null,
    memory: input.memory ?? {
      artifacts: [],
      decisions: [],
      working: []
    },
    mode: input.mode,
    nextActions: input.nextActions ?? [],
    observations: input.observations ?? [],
    pendingAction: input.pendingAction ?? null,
    plan: input.plan ?? null,
    prompt: input.prompt,
    repoContext: input.repoContext,
    status: input.status,
    summary: input.summary,
    updatedAt: now,
    verification: input.verification ?? {
      commands: [],
      inferred: false,
      passed: false,
      runs: []
    }
  };

  const events =
    input.events === undefined
      ? defaultEventsForSession({
          id: sessionId,
          input,
          session
        })
      : input.events.some((event) => event.type === "session_started")
        ? input.events
        : [
            createSessionStartedEvent({
              config: input.config,
              cwd: input.cwd,
              guidance: session.guidance,
              id: sessionId,
              mode: input.mode,
              prompt: input.prompt,
              repoContext: input.repoContext
            }),
            ...input.events
          ];
  const reduced = reduceSessionEvents(events);

  if (!reduced) {
    throw new SessionStoreError("Failed to reduce session events.");
  }

  const persisted = {
    ...session,
    ...reduced
  };

  await appendSessionEvents(persisted.id, events, homeDir);
  await saveSession(persisted, homeDir);
  return persisted;
}

export async function updateSession(
  sessionId: string,
  input: Omit<CreateSessionInput, "cwd" | "mode" | "prompt" | "repoContext"> & {
    cwd: string;
    mode: SessionMode;
    prompt: string;
    repoContext: RepoContextSummary;
    status: SessionStatus;
    summary: string;
  },
  homeDir?: string
): Promise<SessionRecord> {
  const existing = await loadSession(sessionId, homeDir);

  if (!existing) {
    throw new SessionStoreError(`Session \`${sessionId}\` was not found.`);
  }

  const session: SessionRecord = {
    ...existing,
    approvals: input.approvals ?? existing.approvals,
    artifacts: input.artifacts ?? existing.artifacts,
    changedFiles: input.changedFiles ?? existing.changedFiles,
    compaction: input.compaction ?? existing.compaction,
    config: input.config,
    cwd: input.cwd,
    eventCount: input.eventCount ?? existing.eventCount,
    guidance: input.guidance ?? existing.guidance,
    lastEventAt: input.lastEventAt ?? existing.lastEventAt,
    memory: input.memory ?? existing.memory,
    mode: input.mode,
    nextActions: input.nextActions ?? existing.nextActions,
    observations: input.observations ?? existing.observations,
    pendingAction: input.pendingAction ?? existing.pendingAction,
    plan: input.plan ?? existing.plan,
    prompt: input.prompt,
    repoContext: input.repoContext,
    status: input.status,
    summary: input.summary,
    updatedAt: new Date().toISOString(),
    verification: input.verification ?? existing.verification
  };

  const events =
    input.events ??
    defaultStatusEventsForSession({
      session
    });
  const historicalEvents = await loadSessionEvents(sessionId, homeDir);
  const reduced = reduceSessionEvents([...historicalEvents, ...events]);

  if (!reduced) {
    throw new SessionStoreError(`Failed to reduce session \`${sessionId}\` from events.`);
  }

  const persisted = {
    ...session,
    ...reduced
  };

  await appendSessionEvents(sessionId, events, homeDir);
  await saveSession(persisted, homeDir);
  return persisted;
}

export async function saveSession(
  session: SessionRecord,
  homeDir?: string
): Promise<void> {
  await ensureSessionRoot(homeDir);
  const path = getSessionFilePath(session.id, homeDir);
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function loadSession(
  sessionId: string,
  homeDir?: string
): Promise<SessionRecord | null> {
  const path = getSessionFilePath(sessionId, homeDir);
  const events = await loadSessionEvents(sessionId, homeDir);

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const snapshot = sessionRecordSchema.parse(parsed);
    const reduced = reduceSessionEvents(events);
    return reduced ? sessionRecordSchema.parse(reduced) : snapshot;
  } catch (error) {
    if (isMissingFileError(error)) {
      const reduced = reduceSessionEvents(events);
      return reduced ? sessionRecordSchema.parse(reduced) : null;
    }

    if (error instanceof SyntaxError) {
      throw new SessionStoreError(`Invalid JSON for session \`${sessionId}\`.`);
    }

    if (error instanceof Error && error.name === "ZodError") {
      throw new SessionStoreError(`Invalid session data for \`${sessionId}\`.`);
    }

    throw new SessionStoreError(
      error instanceof Error ? error.message : `Failed to load session \`${sessionId}\`.`
    );
  }
}

function defaultEventsForSession(args: {
  id: string;
  input: CreateSessionInput;
  session: SessionRecord;
}): SessionEvent[] {
  return [
    createSessionStartedEvent({
      config: args.input.config,
      cwd: args.input.cwd,
      guidance: args.session.guidance,
      id: args.id,
      mode: args.input.mode,
      prompt: args.input.prompt,
      repoContext: args.input.repoContext
    }),
    createSummaryUpdatedEvent({
      nextActions: args.session.nextActions,
      summary: args.input.summary
    }),
    ...defaultStatusEventsForSession({
      session: args.session
    })
  ];
}

function defaultStatusEventsForSession(args: {
  session: SessionRecord;
}): SessionEvent[] {
  const payload = {
    approvals: args.session.approvals,
    artifacts: args.session.artifacts,
    changedFiles: args.session.changedFiles,
    pendingAction: args.session.pendingAction,
    summary: args.session.summary,
    verification: args.session.verification
  };

  if (args.session.status === "completed") {
    return [createSessionCompletedEvent(payload)];
  }

  if (args.session.status === "paused") {
    return [createSessionPausedEvent(payload)];
  }

  return [createSessionFailedEvent(payload)];
}

export async function listRecentSessions(
  limit = 5,
  homeDir?: string
): Promise<SessionRecord[]> {
  const sessionRoot = getSessionRoot(homeDir);

  try {
    const names = await readdir(sessionRoot);
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const sessionId = basename(name, ".json");
          return loadSession(sessionId, homeDir);
        })
    );

    return sessions
      .filter((session): session is SessionRecord => session !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw new SessionStoreError(
      error instanceof Error ? error.message : "Failed to list sessions."
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
