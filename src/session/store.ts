import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type {
  Approval,
  Artifact,
  Observation,
  PlanState,
  RepoContextSummary,
  VerificationSummary
} from "../cli/output.js";
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

export const sessionRecordSchema = z
  .object({
    approvals: z.array(approvalSchema),
    artifacts: z.array(artifactSchema),
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
  config: SessionRecord["config"];
  cwd: string;
  mode: SessionMode;
  nextActions?: string[];
  observations?: Observation[];
  pendingAction?: SessionRecord["pendingAction"];
  plan?: PlanState | null;
  prompt: string;
  repoContext: RepoContextSummary;
  status: SessionStatus;
  summary: string;
  verification?: VerificationSummary;
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

  await saveSession(session, homeDir);
  return session;
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
    config: input.config,
    cwd: input.cwd,
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
