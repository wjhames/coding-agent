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
    artifacts: session.artifacts,
    verification: session.verification,
    approvals: session.approvals,
    exitCode: session.status === "paused" ? 2 : session.status === "completed" ? 0 : 1,
    changedFiles: session.changedFiles,
    nextActions: session.nextActions,
    plan: session.plan,
    repoContext: session.repoContext,
    resumedFrom: session.id,
    sessionId: session.id,
    status: session.status,
    summary: session.summary
  };
}
