import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { ensureSessionRoot, getSessionFilePath, getSessionRoot } from "./paths.js";

export const sessionStatusSchema = z.enum(["completed", "failed", "paused"]);
export const sessionModeSchema = z.enum(["interactive", "exec"]);

export const sessionRecordSchema = z
  .object({
    approvals: z.array(z.string()),
    artifacts: z.array(z.string()),
    changedFiles: z.array(z.string()),
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
    id: z.string(),
    mode: sessionModeSchema,
    prompt: z.string(),
    status: sessionStatusSchema,
    summary: z.string(),
    updatedAt: z.string(),
    verification: z.object({
      commands: z.array(z.string()),
      passed: z.boolean()
    })
  })
  .strict();

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export interface CreateSessionInput {
  approvals?: string[];
  artifacts?: string[];
  changedFiles?: string[];
  config: SessionRecord["config"];
  cwd: string;
  mode: SessionMode;
  prompt: string;
  status: SessionStatus;
  summary: string;
  verification?: SessionRecord["verification"];
}

export class SessionStoreError extends Error {}

export async function createSession(
  input: CreateSessionInput,
  homeDir?: string
): Promise<SessionRecord> {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    approvals: input.approvals ?? [],
    artifacts: input.artifacts ?? [],
    changedFiles: input.changedFiles ?? [],
    config: input.config,
    createdAt: now,
    cwd: input.cwd,
    id: randomUUID(),
    mode: input.mode,
    prompt: input.prompt,
    status: input.status,
    summary: input.summary,
    updatedAt: now,
    verification: input.verification ?? {
      commands: [],
      passed: false
    }
  };

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
