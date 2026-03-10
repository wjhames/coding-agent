import type { CommandResult } from "../cli/output.js";
import { listRecentSessions, loadSession } from "../session/store.js";

export async function runResume(args: {
  sessionHomeDir: string | undefined;
  sessionId: string | undefined;
}): Promise<CommandResult | null> {
  const session = args.sessionId
    ? await loadSession(args.sessionId, args.sessionHomeDir)
    : (await listRecentSessions(1, args.sessionHomeDir))[0] ?? null;

  if (!session) {
    return null;
  }

  return {
    sessionId: session.id,
    status: session.status,
    resumedFrom: session.id,
    summary: session.summary,
    changedFiles: session.changedFiles,
    artifacts: session.artifacts,
    verification: session.verification,
    approvals: session.approvals,
    exitCode: session.status === "paused" ? 2 : session.status === "completed" ? 0 : 1
  };
}
