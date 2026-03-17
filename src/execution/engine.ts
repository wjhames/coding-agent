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
import { emptyContextSnapshot, emptyGuidanceSummary, emptyVerificationSummary } from "../session/aggregate.js";
import { resultFromSession } from "../session/mappers.js";
import { createSession, listRecentSessions, loadSession, updateSession } from "../session/store.js";
import { applyPatchOperations } from "../tools/apply-patch.js";
import { runShellAction } from "../tools/run-shell.js";
import {
  addArtifacts,
  addChangedFiles,
  buildFinalSummary,
  changedFilesList,
  createExecutionState,
  recordSystemNote,
  recordUserTurn,
  toExecutionSnapshot,
  toRepoContextSummary,
  type ExecutionState
} from "./state.js";
import { isLikelyReadOnlyTask } from "./prompts.js";
import { runModelLoop, emitRuntimeEvent } from "./model-loop.js";
import { runVerificationCycle } from "./verification-cycle.js";

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
    recordPromptTurn: true,
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

  if (args.session.status !== "paused" || args.session.state.pendingAction === null) {
    return resultFromSession(args.session);
  }

  if (resolvedConfig.approvalPolicy === "prompt" || resolvedConfig.approvalPolicy === undefined) {
    return resultFromSession(args.session);
  }

  const state = createExecutionState({
    approvals: args.session.state.approvals,
    artifacts: args.session.state.artifacts,
    changedFiles: args.session.state.changedFiles,
    context: args.session.context,
    guidance: args.session.guidance,
    observations: args.session.state.observations,
    pendingAction: args.session.state.pendingAction,
    plan: args.session.state.plan,
    turns: args.session.turns,
    verification: args.session.state.verification
  });

  if (resolvedConfig.approvalPolicy === "never") {
    const approvalId = args.session.state.pendingAction.approval.id;
    state.approvals = state.approvals.map((approval) =>
      approval.id === approvalId ? { ...approval, status: "rejected" as const } : approval
    );
    state.pendingAction = null;
    recordSystemNote(state, `Approval rejected: ${args.session.state.pendingAction.approval.summary}`);

    const failedSession = await persistSession({
      existingSession: args.session,
      input: {
        config: args.session.config,
        context: state.context,
        cwd: args.session.cwd,
        guidance: args.session.guidance,
        mode: "exec",
        prompt: args.session.prompt,
        repoContext: args.session.repoContext,
        state: toExecutionSnapshot(state),
        status: "failed",
        summary: `Approval denied for pending action: ${args.session.state.pendingAction.approval.summary}`,
        turns: state.turns
      },
      sessionHomeDir: args.sessionHomeDir
    });

    return resultFromSession(failedSession);
  }

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
    prompt: args.session.prompt,
    recordPromptTurn: false,
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
  recordPromptTurn: boolean;
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
      context: emptyContextSnapshot(),
      guidance: guidance.summary,
      observations: [],
      pendingAction: null,
      plan: null,
      turns: [],
      verification: {
        ...emptyVerificationSummary(),
        commands: verificationCommands,
        notRunReason: "Verification has not run yet.",
        selectedCommands: verificationCommands,
        skippedCommands: verificationPlan.skippedCommands
      }
    });
  state.guidance = guidance.summary;
  state.verification = {
    ...state.verification,
    commands: verificationCommands,
    inferred: true,
    selectedCommands: verificationCommands,
    skippedCommands: verificationPlan.skippedCommands
  };

  if (args.recordPromptTurn) {
    recordUserTurn(state, args.prompt);
  }

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

    const status = state.verification.status === "failed" ? "failed" : "completed";
    const finalSummary = buildFinalSummary(summary, {
      changedFiles: changedFilesList(state),
      verification: state.verification
    });
    const persisted = await persistSession({
      existingSession: args.existingSession,
      input: {
        config: resolvedConfig,
        context: state.context,
        cwd: args.cwd,
        guidance: state.guidance,
        mode: "exec",
        prompt: args.prompt,
        repoContext: repoContextSummary,
        state: toExecutionSnapshot(state),
        status,
        summary: finalSummary,
        turns: state.turns
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
      recordSystemNote(state, `Approval required: ${error.approval.summary}`);
      emitRuntimeEvent(args.observer, {
        approval: error.approval,
        at: new Date().toISOString(),
        pendingAction: error.action,
        type: "approval_requested"
      });
      const summary = error.approval.summary;
      const pausedSession = await persistSession({
        existingSession: args.existingSession,
        input: {
          config: resolvedConfig,
          context: state.context,
          cwd: args.cwd,
          guidance: state.guidance,
          mode: "exec",
          prompt: args.prompt,
          repoContext: repoContextSummary,
          state: toExecutionSnapshot(state),
          status: "paused",
          summary,
          turns: state.turns
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
      recordSystemNote(state, error.message);
      const failedSession = await persistSession({
        existingSession: args.existingSession,
        input: {
          config: resolvedConfig,
          context: state.context,
          cwd: args.cwd,
          guidance: state.guidance,
          mode: "exec",
          prompt: args.prompt,
          repoContext: repoContextSummary,
          state: toExecutionSnapshot(state),
          status: "failed",
          summary: error.message,
          turns: state.turns
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
  emitRuntimeEvent(args.observer, {
    approvalId,
    at: new Date().toISOString(),
    status: "approved",
    type: "approval_resolved"
  });
  args.state.approvals = args.state.approvals.map((approval) =>
    approval.id === approvalId ? { ...approval, status: "approved" as const } : approval
  );
  recordSystemNote(args.state, `Approval approved: ${args.state.pendingAction.approval.summary}`);

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
}

async function persistSession(args: {
  existingSession: SessionRecord | null;
  input: {
    config: SessionRecord["config"];
    context: SessionRecord["context"];
    cwd: string;
    guidance: SessionRecord["guidance"];
    mode: "exec";
    prompt: string;
    repoContext: SessionRecord["repoContext"];
    state: SessionRecord["state"];
    status: "completed" | "failed" | "paused";
    summary: string;
    turns: SessionRecord["turns"];
  };
  sessionHomeDir: string | undefined;
}): Promise<SessionRecord> {
  if (args.existingSession) {
    return updateSession(args.existingSession.id, args.input, args.sessionHomeDir);
  }

  return createSession(args.input, args.sessionHomeDir);
}
