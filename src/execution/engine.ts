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
import { emptyContextSnapshot, emptyVerificationSummary } from "../session/aggregate.js";
import { resultFromSession } from "../session/mappers.js";
import { createSession, listRecentSessions, loadSession, updateSession } from "../session/store.js";
import { applyPatchOperations } from "../tools/apply-patch.js";
import { runShellAction } from "../tools/run-shell.js";
import { findCompletionFailureReason, sanitizeAssistantText } from "./completion.js";
import {
  addObservation,
  addArtifacts,
  addChangedFiles,
  buildFinalSummary,
  changedFilesList,
  createExecutionState,
  recordSystemNote,
  recordToolResultTurn,
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
    sessionHomeDir: args.sessionHomeDir,
    sessionPrompt: args.prompt
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

export async function runContinue(args: {
  fetchImpl: typeof fetch | undefined;
  observer: RuntimeObserver | undefined;
  options: ParsedOptions;
  prompt: string;
  sessionHomeDir: string | undefined;
  sessionId: string;
}): Promise<CommandResult | null> {
  const session = await loadSession(args.sessionId, args.sessionHomeDir);

  if (!session) {
    return null;
  }

  const state = createExecutionState({
    approvals: session.state.approvals,
    artifacts: session.state.artifacts,
    changedFiles: session.state.changedFiles,
    context: session.context,
    guidance: session.guidance,
    observations: session.state.observations,
    pendingAction: session.state.pendingAction,
    plan: session.state.plan,
    turns: session.turns,
    verification: session.state.verification
  });
  recordUserTurn(state, args.prompt);

  const result = await executeTask({
    cwd: session.cwd,
    existingSession: session,
    fetchImpl: args.fetchImpl,
    observer: args.observer,
    options: args.options,
    prompt: args.prompt,
    recordPromptTurn: false,
    sessionHomeDir: args.sessionHomeDir,
    sessionPrompt: session.prompt,
    state
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
    sessionPrompt: args.session.prompt,
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
  sessionPrompt: string;
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
  let repoContext = await collectRepoContext(args.cwd);
  const readOnlyTask = isLikelyReadOnlyTask(args.prompt);
  const guidance = await loadGuidance({
    cwd: args.cwd,
    homeDir: args.sessionHomeDir,
    prompt: args.prompt,
    repoGuidanceFiles: repoContext.guidanceFiles
  });
  let verificationPlan = planVerificationCommands({
    packageScripts: repoContext.packageScripts
  });
  let verificationCommands = verificationPlan.commands;
  let repoContextSummary = toRepoContextSummary(repoContext);
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

    if (state.changedFiles.size > 0) {
      repoContext = await collectRepoContext(args.cwd);
      repoContextSummary = toRepoContextSummary(repoContext);
      verificationPlan = planVerificationCommands({
        packageScripts: repoContext.packageScripts
      });
      verificationCommands = verificationPlan.commands;
      state.verification = {
        ...state.verification,
        commands: verificationCommands,
        inferred: true,
        selectedCommands: verificationCommands,
        skippedCommands: verificationPlan.skippedCommands
      };
    }

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

    const sanitizedSummary = sanitizeAssistantText(summary);
    const completionFailureReason = findCompletionFailureReason(sanitizedSummary);
    const status =
      state.verification.status === "failed" || completionFailureReason !== null ? "failed" : "completed";
    const finalSummary = buildFinalSummary(
      completionFailureReason
        ? `${sanitizedSummary}\n\nIncomplete task: ${completionFailureReason}`
        : sanitizedSummary,
      {
        changedFiles: changedFilesList(state),
        verification: state.verification
      }
    );
    const persisted = await persistSession({
      existingSession: args.existingSession,
      input: {
        config: resolvedConfig,
        context: state.context,
        cwd: args.cwd,
        guidance: state.guidance,
        mode: "exec",
        prompt: args.sessionPrompt,
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
          prompt: args.sessionPrompt,
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
          prompt: args.sessionPrompt,
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
  const pendingAction = args.state.pendingAction;
  recordSystemNote(args.state, `Approval approved: ${pendingAction.approval.summary}`);

  const tool = pendingAction.tool;
  const inputSummary =
    tool === "apply_patch"
      ? JSON.stringify({
          operations: pendingAction.action.operations
        })
      : JSON.stringify({
          command: pendingAction.action.command,
          ...(pendingAction.action.justification
            ? { justification: pendingAction.action.justification }
            : {})
        });

  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    inputSummary,
    tool,
    type: "tool_called"
  });
  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    ...(tool === "apply_patch" ? { detail: "Applying changes." } : { detail: "Running command." }),
    status: tool === "apply_patch" ? "editing" : "verifying",
    type: "status"
  });

  const beforeObservationCount = args.state.observations.length;
  const beforeArtifactCount = args.state.artifacts.length;
  const beforeChangedFiles = new Set(args.state.changedFiles);

  try {
    if (tool === "apply_patch") {
      await applyPatchOperations({
        addArtifacts: (artifacts) => {
          addArtifacts(args.state, artifacts);
        },
        addChangedFiles: (files) => {
          addChangedFiles(args.state, files);
        },
        addObservation: (observation) => {
          addObservation(args.state, observation);
        },
        cwd: args.cwd,
        operations: pendingAction.action.operations
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
          addObservation(args.state, observation);
        },
        command: pendingAction.action.command,
        cwd: args.cwd
      });
    }

    const latestObservation = args.state.observations.at(-1);
    const newArtifacts = args.state.artifacts.slice(beforeArtifactCount);
    const newChangedFiles = changedFilesList(args.state).filter((path) => !beforeChangedFiles.has(path));
    recordToolResultTurn({
      ...(newChangedFiles.length > 0 ? { changedFiles: newChangedFiles } : {}),
      ...(latestObservation?.path ? { paths: [latestObservation.path] } : {}),
      state: args.state,
      summary:
        latestObservation?.summary ??
        (newChangedFiles.length > 0 ? `Updated ${newChangedFiles.join(", ")}.` : `${tool} completed.`),
      tool
    });
    emitRuntimeEvent(args.observer, {
      ...(args.state.observations.length > beforeObservationCount && latestObservation
        ? { observation: latestObservation }
        : {}),
      ...(newArtifacts.length > 0 ? { artifacts: newArtifacts } : {}),
      ...(newChangedFiles.length > 0 ? { changedFiles: newChangedFiles } : {}),
      at: new Date().toISOString(),
      tool,
      type: "tool_result"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tool failure.";
    const observation =
      tool === "run_shell" || tool === "apply_patch"
        ? {
            excerpt: message,
            summary: `Tool error from ${tool}: ${message}`,
            tool
          }
        : null;

    if (observation) {
      addObservation(args.state, observation);
    }
    recordToolResultTurn({
      error: message,
      state: args.state,
      summary: observation?.summary ?? `Tool error from ${tool}: ${message}`,
      tool
    });
    emitRuntimeEvent(args.observer, {
      at: new Date().toISOString(),
      error: message,
      ...(observation ? { observation } : {}),
      tool,
      type: "tool_result"
    });
    args.state.pendingAction = null;
    throw error;
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
