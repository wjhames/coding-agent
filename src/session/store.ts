import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  appendSessionEvents,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionPausedEvent,
  createSessionStartedEvent,
  createSummaryUpdatedEvent,
  loadSessionEvents,
  type SessionEvent
} from "./events.js";
import {
  createSessionRecord,
  emptyGuidanceSummary,
  reduceSessionEvents,
  sessionRecordSchema,
  type CreateSessionInput,
  type SessionMode,
  type SessionRecord,
  type SessionStatus
} from "./aggregate.js";
import { ensureSessionRoot, getSessionFilePath, getSessionRoot } from "./paths.js";

export { sessionRecordSchema, type CreateSessionInput, type SessionMode, type SessionRecord, type SessionStatus } from "./aggregate.js";

export class SessionStoreError extends Error {}

export async function createSession(
  input: CreateSessionInput,
  homeDir?: string
): Promise<SessionRecord> {
  const sessionId = randomUUID();
  const session = createSessionRecord({
    id: sessionId,
    input
  });

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
              guidance: input.guidance ?? emptyGuidanceSummary(),
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
    repoContext: SessionRecord["repoContext"];
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
      guidance: args.input.guidance ?? emptyGuidanceSummary(),
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
