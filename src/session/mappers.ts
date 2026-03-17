import type { CommandResult } from "../runtime/contracts.js";
import type { SessionRecord } from "./aggregate.js";

export function resultFromSession(session: SessionRecord): CommandResult {
  const pendingApproval =
    session.state.pendingAction === null
      ? null
      : {
          actionClass: session.state.pendingAction.approval.actionClass,
          ...(session.state.pendingAction.tool === "run_shell"
            ? { command: session.state.pendingAction.action.command }
            : { operationCount: session.state.pendingAction.action.operations.length }),
          reason: session.state.pendingAction.approval.reason,
          summary: session.state.pendingAction.approval.summary,
          tool: session.state.pendingAction.tool
        };
  const resumeCommand =
    session.status === "paused"
      ? `coding-agent resume ${session.id} --approval-policy auto`
      : null;

  return {
    approvals: session.state.approvals,
    artifacts: session.state.artifacts,
    changedFiles: session.state.changedFiles,
    context: session.context,
    exitCode: session.status === "paused" ? 2 : session.status === "completed" ? 0 : 1,
    guidance: session.guidance,
    nextActions: session.state.nextActions,
    observations: session.state.observations,
    pendingApproval,
    plan: session.state.plan,
    repoContext: session.repoContext,
    resumeCommand,
    sessionId: session.id,
    status: session.status,
    summary: session.summary,
    turnCount: session.turns.length,
    verification: session.state.verification
  };
}
