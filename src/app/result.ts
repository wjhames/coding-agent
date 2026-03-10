import type { CommandResult } from "../cli/output.js";
import type { SessionRecord } from "../session/store.js";

export function resultFromSession(session: SessionRecord): CommandResult {
  const pendingApproval =
    session.pendingAction === null
      ? null
      : {
          actionClass: session.pendingAction.approval.actionClass,
          ...(session.pendingAction.tool === "run_shell"
            ? { command: session.pendingAction.action.command }
            : { operationCount: session.pendingAction.action.operations.length }),
          reason: session.pendingAction.approval.reason,
          summary: session.pendingAction.approval.summary,
          tool: session.pendingAction.tool
        };
  const resumeCommand =
    session.status === "paused"
      ? `coding-agent resume ${session.id} --approval-policy auto`
      : null;

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
    pendingApproval,
    plan: session.plan,
    repoContext: session.repoContext,
    resumeCommand,
    sessionId: session.id,
    status: session.status,
    summary: session.summary,
    verification: session.verification
  };
}
