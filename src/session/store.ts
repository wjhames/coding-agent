import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  createSessionRecord,
  sessionRecordSchema,
  updateSessionRecord,
  type CreateSessionInput,
  type SessionMode,
  type SessionRecord,
  type SessionStatus,
  type UpdateSessionInput
} from "./aggregate.js";
import { ensureSessionRoot, getSessionFilePath, getSessionRoot } from "./paths.js";

export {
  sessionRecordSchema,
  type CreateSessionInput,
  type SessionMode,
  type SessionRecord,
  type SessionStatus,
  type UpdateSessionInput
} from "./aggregate.js";

export class SessionStoreError extends Error {}

export async function createSession(
  input: CreateSessionInput,
  homeDir?: string
): Promise<SessionRecord> {
  const session = createSessionRecord({
    id: randomUUID(),
    input
  });

  await saveSession(session, homeDir);
  return session;
}

export async function updateSession(
  sessionId: string,
  input: UpdateSessionInput,
  homeDir?: string
): Promise<SessionRecord> {
  const existing = await loadSession(sessionId, homeDir);

  if (!existing) {
    throw new SessionStoreError(`Session \`${sessionId}\` was not found.`);
  }

  const session = updateSessionRecord(existing, input);
  await saveSession(session, homeDir);
  return session;
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

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return sessionRecordSchema.parse(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
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

export async function listRecentSessions(
  limit = 5,
  homeDir?: string
): Promise<SessionRecord[]> {
  const sessionRoot = getSessionRoot(homeDir);

  try {
    const names = await readdir(sessionRoot);
    const settled = await Promise.allSettled(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => loadSession(basename(name, ".json"), homeDir))
    );

    return settled
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
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
