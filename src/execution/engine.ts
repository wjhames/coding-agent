import { resolve } from "node:path";
import { ApprovalDeniedError, ApprovalRequiredError, type PendingAction } from "../app/approval.js";
import { collectRepoContext } from "../app/context.js";
import { loadGuidance } from "../app/guidance.js";
import { planVerificationCommands } from "../app/verification.js";
import {
  loadConfig,
  resolveExecutionConfig,
  resolveLlmConfig
} from "../config/load.js";
import type { ParsedOptions } from "../cli/parse.js";
import { createOpenAICompatibleClient } from "../llm/openai-client.js";
import type { CommandResult, RuntimeObserver } from "../runtime/contracts.js";
import type { SessionRecord } from "../session/aggregate.js";
import { emptyCompactionSummary, emptyMemorySummary } from "../session/aggregate.js";
import { resultFromSession } from "../session/mappers.js";
import { createSession, updateSession } from "../session/store.js";
import {
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createCompactionUpdatedEvent,
  createMemoryUpdatedEvent,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionPausedEvent,
  createSummaryUpdatedEvent
} from "../session/events.js";
import { applyPatchOperations } from "../tools/apply-patch.js";
import { runShellAction } from "../tools/run-shell.js";
import {
  addArtifacts,
  addChangedFiles,
  buildFinalSummary,
  changedFilesList,
  createExecutionState,
  deriveNextActions,
  syncDerivedState,
  toRepoContextSummary,
  type ExecutionState
} from "./state.js";
import { buildResumePrompt, isLikelyReadOnlyTask } from "./prompts.js";
import { runModelLoop, emitRuntimeEvent } from "./model-loop.js";
import { runVerificationCycle } from "./verification-cycle.js";
import { listRecentSessions, loadSession } from "../session/store.js";

export async function runExec(args: {
  fetchImpl: typeof fetch | undefined;
  observer: RuntimeObserver | undefined;
  options: ParsedOptions;
  prompt: string;
  processCwd: string | undefined;
  sessionHomeDir: string | undefined;
}): Promise<CommandResult> {
  const cwd = resolve(args.processCwd ?? process.cwd(), args.options.cwd ?? ".");
  return executeTask({
    cwd,
    existingSession: null,
    fetchImpl: args.fetchImpl,
    observer: args.observer,
    options: args.options,
    prompt: args.prompt,
    sessionHomeDir: args.sessionHomeDir
  });
}

export async function runResume(args: {
  fetchImpl: typeof fetch | undefined;
  observer: RuntimeObserver | undefined;
  options: ParsedOptions;
  sessionHomeDir: string | undefined;
  sessionId: string | undefined;
}): Promise<CommandResult | null> {
  const session = args.sessionId
    ? await loadSession(args.sessionId, args.sessionHomeDir)
    : (await listRecentSessions(1, args.sessionHomeDir))[0] ?? null;

  if (!session) {
    return null;
  }

  if (session.status !== "paused") {
    return {
      ...resultFromSession(session),
      resumedFrom: session.id
    };
  }

  const result = await continueExec({
    fetchImpl: args.fetchImpl,
    observer: args.observer,
    options: args.options,
    session,
    sessionHomeDir: args.sessionHomeDir
  });

  return {
    ...result,
    resumedFrom: session.id
  };
}

async function continueExec(args: {
  fetchImpl: typeof fetch | undefined;
  observer: RuntimeObserver | undefined;
  options: ParsedOptions;
  session: SessionRecord;
  sessionHomeDir: string | undefined;
}): Promise<CommandResult> {
  const config = await loadConfig(args.sessionHomeDir);
  const resolvedConfig = resolveExecutionConfig({
    cliOptions: args.options,
    config
  });

  if (args.session.status !== "paused" || args.session.pendingAction === null) {
    return resultFromSession(args.session);
  }

  if (resolvedConfig.approvalPolicy === "prompt" || resolvedConfig.approvalPolicy === undefined) {
    return resultFromSession(args.session);
  }

  if (resolvedConfig.approvalPolicy === "never") {
    const rejectionEvent = createApprovalResolvedEvent({
      approvalId: args.session.pendingAction.approval.id,
      status: "rejected"
    });
    const rejectedApprovals = args.session.approvals.map((approval) =>
      approval.id === args.session.pendingAction?.approval.id
        ? { ...approval, status: "rejected" as const }
        : approval
    );
    const rejectedState = createExecutionState({
      approvals: rejectedApprovals,
      artifacts: args.session.artifacts,
      changedFiles: args.session.changedFiles,
      compaction: args.session.compaction,
      guidance: args.session.guidance,
      memory: args.session.memory,
      observations: args.session.observations,
      pendingAction: null,
      plan: args.session.plan,
      verification: args.session.verification
    });
    rejectedState.events.push(rejectionEvent);
    syncDerivedState(rejectedState);
    const failedSession = await updateSession(
      args.session.id,
      {
        approvals: rejectedState.approvals,
        artifacts: rejectedState.artifacts,
        changedFiles: changedFilesList(rejectedState),
        compaction: rejectedState.compaction,
        config: args.session.config,
        cwd: args.session.cwd,
        eventCount: args.session.eventCount,
        events: rejectedState.events,
        guidance: args.session.guidance,
        lastEventAt: rejectionEvent.at,
        memory: rejectedState.memory,
        mode: args.session.mode,
        nextActions: args.session.nextActions,
        observations: rejectedState.observations,
        pendingAction: null,
        plan: args.session.plan,
        prompt: args.session.prompt,
        repoContext: args.session.repoContext,
        status: "failed",
        summary: `Approval denied for pending action: ${args.session.pendingAction.approval.summary}`,
        verification: args.session.verification
      },
      args.sessionHomeDir
    );

    return resultFromSession(failedSession);
  }

  const state = createExecutionState({
    approvals: args.session.approvals,
    artifacts: args.session.artifacts,
    changedFiles: args.session.changedFiles,
    compaction: args.session.compaction,
    guidance: args.session.guidance,
    memory: args.session.memory,
    observations: args.session.observations,
    pendingAction: args.session.pendingAction,
    plan: args.session.plan,
    verification: args.session.verification
  });
  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    detail: `Resuming session ${args.session.id}`,
    status: "resuming",
    type: "status"
  });
  await executePendingAction({
    cwd: args.session.cwd,
    observer: args.observer,
    state
  });

  return executeTask({
    cwd: args.session.cwd,
    existingSession: args.session,
    fetchImpl: args.fetchImpl,
    observer: args.observer,
    options: args.options,
    prompt: buildResumePrompt(args.session),
    sessionHomeDir: args.sessionHomeDir,
    state
  });
}

async function executeTask(args: {
  cwd: string;
  existingSession: SessionRecord | null;
  fetchImpl: typeof fetch | undefined;
  observer: RuntimeObserver | undefined;
  options: ParsedOptions;
  prompt: string;
  sessionHomeDir: string | undefined;
  state?: ExecutionState;
}): Promise<CommandResult> {
  const config = await loadConfig(args.sessionHomeDir);
  const resolvedConfig = resolveExecutionConfig({
    cliOptions: args.options,
    config
  });
  const llmConfig = resolveLlmConfig({
    config,
    executionConfig: resolvedConfig
  });
  const repoContext = await collectRepoContext(args.cwd);
  const readOnlyTask = isLikelyReadOnlyTask(args.prompt);
  const guidance = await loadGuidance({
    cwd: args.cwd,
    homeDir: args.sessionHomeDir,
    prompt: args.prompt,
    repoGuidanceFiles: repoContext.guidanceFiles
  });
  const verificationPlan = planVerificationCommands({
    packageScripts: repoContext.packageScripts
  });
  const verificationCommands = verificationPlan.commands;
  const repoContextSummary = toRepoContextSummary(repoContext);
  const state =
    args.state ??
    createExecutionState({
      changedFiles: [],
      compaction: emptyCompactionSummary(),
      guidance: guidance.summary,
      memory: emptyMemorySummary(),
      observations: [],
      pendingAction: null,
      plan: null,
      verification: {
        commands: verificationCommands,
        inferred: true,
        notRunReason: "Verification has not run yet.",
        passed: false,
        ran: false,
        runs: [],
        selectedCommands: verificationCommands,
        skippedCommands: verificationPlan.skippedCommands,
        status: "not_run"
      }
    });
  state.verification.commands = verificationCommands;
  state.verification.inferred = true;
  syncDerivedState(state);

  const client = createOpenAICompatibleClient({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {})
  });

  try {
    emitRuntimeEvent(args.observer, {
      at: new Date().toISOString(),
      detail: "Preparing model loop",
      status: "planning",
      type: "status"
    });
    let summary = await runModelLoop({
      client,
      config: resolvedConfig,
      cwd: args.cwd,
      guidance,
      observer: args.observer,
      prompt: args.prompt,
      readOnlyTask,
      repoContext,
      state,
      verificationCommands
    });

    const verificationResult = await runVerificationCycle({
      client,
      config: resolvedConfig,
      cwd: args.cwd,
      guidance,
      observer: args.observer,
      originalPrompt: args.prompt,
      repoContext,
      skippedCommands: verificationPlan.skippedCommands,
      state,
      verificationCommands
    });
    if (verificationResult.summary.length > 0) {
      summary = verificationResult.summary;
    }

    syncDerivedState(state);
    const nextActions = deriveNextActions(state.plan);
    const status = state.verification.status === "failed" ? "failed" : "completed";
    const finalSummary = buildFinalSummary(summary, {
      changedFiles: changedFilesList(state),
      verification: state.verification
    });
    state.events.push(
      createSummaryUpdatedEvent({
        nextActions,
        summary: finalSummary
      })
    );
    state.events.push(
      status === "completed"
        ? createSessionCompletedEvent({
            approvals: state.approvals,
            artifacts: state.artifacts,
            changedFiles: changedFilesList(state),
            pendingAction: null,
            summary: finalSummary,
            verification: state.verification
          })
        : createSessionFailedEvent({
            approvals: state.approvals,
            artifacts: state.artifacts,
            changedFiles: changedFilesList(state),
            pendingAction: null,
            summary: finalSummary,
            verification: state.verification
          })
    );
    const persisted = await persistSession({
      existingSession: args.existingSession,
      input: {
        approvals: state.approvals,
        artifacts: state.artifacts,
        changedFiles: changedFilesList(state),
        compaction: state.compaction,
        config: resolvedConfig,
        cwd: args.cwd,
        events: state.events,
        guidance: state.guidance,
        memory: state.memory,
        mode: "exec",
        nextActions,
        observations: state.observations,
        pendingAction: null,
        plan: state.plan,
        prompt: args.prompt,
        repoContext: repoContextSummary,
        status,
        summary: finalSummary,
        verification: state.verification
      },
      sessionHomeDir: args.sessionHomeDir
    });
    const result = resultFromSession(persisted);
    emitRuntimeEvent(args.observer, {
      at: new Date().toISOString(),
      status,
      type: "status"
    });
    emitRuntimeEvent(args.observer, {
      at: new Date().toISOString(),
      result,
      type: "run_finished"
    });
    return result;
  } catch (error) {
    if (error instanceof ApprovalRequiredError) {
      state.pendingAction = error.action;
      state.approvals = [...state.approvals.filter((item) => item.id !== error.approval.id), error.approval];
      state.events.push(
        createApprovalRequestedEvent({
          approval: error.approval,
          pendingAction: error.action
        })
      );
      emitRuntimeEvent(args.observer, {
        approval: error.approval,
        at: new Date().toISOString(),
        pendingAction: error.action,
        type: "approval_requested"
      });
      syncDerivedState(state);
      const summary = error.approval.summary;
      state.events.push(
        createSummaryUpdatedEvent({
          nextActions: deriveNextActions(state.plan),
          summary
        })
      );
      state.events.push(
        createSessionPausedEvent({
          approvals: state.approvals,
          artifacts: state.artifacts,
          changedFiles: changedFilesList(state),
          pendingAction: state.pendingAction,
          summary,
          verification: state.verification
        })
      );
      const pausedSession = await persistSession({
        existingSession: args.existingSession,
        input: {
          approvals: state.approvals,
          artifacts: state.artifacts,
          changedFiles: changedFilesList(state),
          compaction: state.compaction,
          config: resolvedConfig,
          cwd: args.cwd,
          events: state.events,
          guidance: state.guidance,
          memory: state.memory,
          mode: "exec",
          nextActions: deriveNextActions(state.plan),
          observations: state.observations,
          pendingAction: state.pendingAction,
          plan: state.plan,
          prompt: args.prompt,
          repoContext: repoContextSummary,
          status: "paused",
          summary,
          verification: state.verification
        },
        sessionHomeDir: args.sessionHomeDir
      });
      const result = resultFromSession(pausedSession);
      emitRuntimeEvent(args.observer, {
        at: new Date().toISOString(),
        detail: summary,
        status: "paused",
        type: "status"
      });
      emitRuntimeEvent(args.observer, {
        at: new Date().toISOString(),
        result,
        type: "run_finished"
      });
      return result;
    }

    if (error instanceof ApprovalDeniedError) {
      throw error;
    }

    if (error instanceof Error) {
      syncDerivedState(state);
      const failedSession = await persistSession({
        existingSession: args.existingSession,
        input: {
          approvals: state.approvals,
          artifacts: state.artifacts,
          changedFiles: changedFilesList(state),
          compaction: state.compaction,
          config: resolvedConfig,
          cwd: args.cwd,
          events: [
            ...state.events,
            createSummaryUpdatedEvent({
              nextActions: deriveNextActions(state.plan),
              summary: error.message
            }),
            createSessionFailedEvent({
              approvals: state.approvals,
              artifacts: state.artifacts,
              changedFiles: changedFilesList(state),
              pendingAction: null,
              summary: error.message,
              verification: state.verification
            })
          ],
          guidance: state.guidance,
          memory: state.memory,
          mode: "exec",
          nextActions: deriveNextActions(state.plan),
          observations: state.observations,
          pendingAction: null,
          plan: state.plan,
          prompt: args.prompt,
          repoContext: repoContextSummary,
          status: "failed",
          summary: error.message,
          verification: state.verification
        },
        sessionHomeDir: args.sessionHomeDir
      });
      const result = resultFromSession(failedSession);
      emitRuntimeEvent(args.observer, {
        at: new Date().toISOString(),
        detail: error.message,
        status: "failed",
        type: "status"
      });
      emitRuntimeEvent(args.observer, {
        at: new Date().toISOString(),
        result,
        type: "run_finished"
      });
      return result;
    }

    throw error;
  }
}

async function executePendingAction(args: {
  cwd: string;
  observer: RuntimeObserver | undefined;
  state: ExecutionState;
}): Promise<void> {
  if (args.state.pendingAction === null) {
    return;
  }

  const approvalId = args.state.pendingAction.approval.id;
  args.state.events.push(
    createApprovalResolvedEvent({
      approvalId,
      status: "approved"
    })
  );
  emitRuntimeEvent(args.observer, {
    approvalId,
    at: new Date().toISOString(),
    status: "approved",
    type: "approval_resolved"
  });
  args.state.approvals = args.state.approvals.map((approval) =>
    approval.id === approvalId ? { ...approval, status: "approved" as const } : approval
  );

  if (args.state.pendingAction.tool === "apply_patch") {
    await applyPatchOperations({
      addArtifacts: (artifacts) => {
        addArtifacts(args.state, artifacts);
      },
      addChangedFiles: (files) => {
        addChangedFiles(args.state, files);
      },
      addObservation: (observation) => {
        args.state.observations.push(observation);
      },
      cwd: args.cwd,
      operations: args.state.pendingAction.action.operations
    });
  } else {
    await runShellAction({
      addArtifacts: (artifacts) => {
        addArtifacts(args.state, artifacts);
      },
      addChangedFiles: (files) => {
        addChangedFiles(args.state, files);
      },
      addObservation: (observation) => {
        args.state.observations.push(observation);
      },
      command: args.state.pendingAction.action.command,
      cwd: args.cwd
    });
  }

  args.state.pendingAction = null;
  syncDerivedState(args.state);
}

async function persistSession(args: {
  existingSession: SessionRecord | null;
  input: {
    approvals: ExecutionState["approvals"];
    artifacts: ExecutionState["artifacts"];
    changedFiles: string[];
    compaction: ExecutionState["compaction"];
    config: SessionRecord["config"];
    cwd: string;
    events: SessionRecord["eventCount"] extends number ? import("../session/events.js").SessionEvent[] : never;
    guidance: ExecutionState["guidance"];
    memory: ExecutionState["memory"];
    mode: "exec";
    nextActions: string[];
    observations: ExecutionState["observations"];
    pendingAction: PendingAction | null;
    plan: ExecutionState["plan"];
    prompt: string;
    repoContext: SessionRecord["repoContext"];
    status: "completed" | "failed" | "paused";
    summary: string;
    verification: ExecutionState["verification"];
  };
  sessionHomeDir: string | undefined;
}): Promise<SessionRecord> {
  if (args.existingSession) {
    return updateSession(args.existingSession.id, args.input, args.sessionHomeDir);
  }

  return createSession(args.input, args.sessionHomeDir);
}
