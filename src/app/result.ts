import type { CommandResult } from "../cli/output.js";
import type { SessionRecord } from "../session/store.js";

export function resultFromSession(session: SessionRecord): CommandResult {
  return {
    approvals: session.approvals,
    artifacts: session.artifacts,
    changedFiles: session.changedFiles,
    compaction: session.compaction,
    eventCount: session.eventCount,
    exitCode: session.status === "paused" ? 2 : session.status === "completed" ? 0 : 1,
    guidance: session.guidance,
    lastEventAt: session.lastEventAt,
    memory: session.memory,
    nextActions: session.nextActions,
    observations: session.observations,
    plan: session.plan,
    repoContext: session.repoContext,
    sessionId: session.id,
    status: session.status,
    summary: session.summary,
    verification: session.verification
  };
}
