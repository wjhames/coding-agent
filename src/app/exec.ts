import { resolve } from "node:path";
import type {
  Approval,
  Artifact,
  CommandResult,
  Observation,
  PlanState,
  RepoContextSummary,
  VerificationSummary
} from "../cli/output.js";
import { ApprovalDeniedError, ApprovalRequiredError, type PendingAction } from "./approval.js";
import { collectRepoContext, type RepoContext } from "./context.js";
import { resultFromSession } from "./result.js";
import { runVerificationCommands } from "./verification-runner.js";
import { inferVerificationCommands } from "./verification.js";
import {
  loadConfig,
  resolveExecutionConfig,
  resolveLlmConfig,
  type ResolvedExecutionConfig
} from "../config/load.js";
import type { ParsedOptions } from "../cli/parse.js";
import { createOpenAICompatibleClient } from "../llm/openai.js";
import { LlmError } from "../llm/openai.js";
import type { SessionRecord } from "../session/store.js";
import { createSession, updateSession } from "../session/store.js";
import { createApplyPatchTool, applyPatchOperations } from "../tools/apply-patch.js";
import { createListFilesTool } from "../tools/list-files.js";
import { createReadFileTool } from "../tools/read-file.js";
import { createRunShellTool, runShellAction } from "../tools/run-shell.js";
import { createSearchFilesTool } from "../tools/search-files.js";
import { createWritePlanTool } from "../tools/write-plan.js";

interface RuntimeState {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: Set<string>;
  observations: Observation[];
  pendingAction: PendingAction | null;
  plan: PlanState | null;
  verification: VerificationSummary;
}

export async function runExec(args: {
  fetchImpl: typeof fetch | undefined;
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
    options: args.options,
    prompt: args.prompt,
    sessionHomeDir: args.sessionHomeDir
  });
}

export async function continueExec(args: {
  fetchImpl: typeof fetch | undefined;
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
    const rejectedApprovals = args.session.approvals.map((approval) =>
      approval.id === args.session.pendingAction?.approval.id
        ? { ...approval, status: "rejected" as const }
        : approval
    );
    const failedSession = await updateSession(
      args.session.id,
      {
        approvals: rejectedApprovals,
        artifacts: args.session.artifacts,
        changedFiles: args.session.changedFiles,
        config: args.session.config,
        cwd: args.session.cwd,
        mode: args.session.mode,
        nextActions: args.session.nextActions,
        observations: args.session.observations,
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

  const state = createRuntimeState(args.session);
  await executePendingAction({
    config: resolvedConfig,
    cwd: args.session.cwd,
    state
  });

  return executeTask({
    cwd: args.session.cwd,
    existingSession: args.session,
    fetchImpl: args.fetchImpl,
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
  options: ParsedOptions;
  prompt: string;
  sessionHomeDir: string | undefined;
  state?: RuntimeState;
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
  const verificationCommands = inferVerificationCommands({
    packageScripts: repoContext.packageScripts
  });
  const repoContextSummary = toRepoContextSummary(repoContext);
  const state =
    args.state ??
    createRuntimeState({
      approvals: [],
      artifacts: [],
      changedFiles: [],
      observations: [],
      pendingAction: null,
      plan: null,
      repoContext: repoContextSummary,
      verification: {
        commands: verificationCommands,
        inferred: true,
        passed: true,
        runs: []
      }
    });
  state.verification.commands = verificationCommands;
  state.verification.inferred = true;

  const client = createOpenAICompatibleClient({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {})
  });

  try {
    const initialSummary = await runModelLoop({
      client,
      config: resolvedConfig,
      cwd: args.cwd,
      prompt: args.prompt,
      repoContext,
      state,
      verificationCommands
    });

    let summary = initialSummary;

    if (state.changedFiles.size > 0 && verificationCommands.length > 0) {
      state.verification = await runVerificationCommands({
        commands: verificationCommands,
        cwd: args.cwd
      });
      appendVerificationObservations(state);

      if (!state.verification.passed) {
        summary = await runModelLoop({
          client,
          config: resolvedConfig,
          cwd: args.cwd,
          prompt: buildVerificationFailurePrompt({
            originalPrompt: args.prompt,
            state
          }),
          repoContext,
          state,
          verificationCommands
        });
        state.verification = await runVerificationCommands({
          commands: verificationCommands,
          cwd: args.cwd
        });
        appendVerificationObservations(state);
      }
    } else {
      state.verification = {
        commands: verificationCommands,
        inferred: true,
        passed: true,
        runs: []
      };
    }

    const nextActions = deriveNextActions(state.plan);
    const status = state.verification.passed ? "completed" : "failed";
    const persisted = await persistSession({
      existingSession: args.existingSession,
      sessionHomeDir: args.sessionHomeDir,
      input: {
        approvals: state.approvals,
        artifacts: state.artifacts,
        changedFiles: [...state.changedFiles],
        config: resolvedConfig,
        cwd: args.cwd,
        mode: "exec",
        nextActions,
        observations: state.observations,
        pendingAction: null,
        plan: state.plan,
        prompt: args.prompt,
        repoContext: repoContextSummary,
        status,
        summary: buildFinalSummary(summary, state.verification),
        verification: state.verification
      }
    });

    return resultFromSession(persisted);
  } catch (error) {
    if (error instanceof ApprovalRequiredError) {
      state.pendingAction = error.action;
      state.approvals = upsertApproval(state.approvals, error.approval);
      const pausedSession = await persistSession({
        existingSession: args.existingSession,
        sessionHomeDir: args.sessionHomeDir,
        input: {
          approvals: state.approvals,
          artifacts: state.artifacts,
          changedFiles: [...state.changedFiles],
          config: resolvedConfig,
          cwd: args.cwd,
          mode: "exec",
          nextActions: deriveNextActions(state.plan),
          observations: state.observations,
          pendingAction: state.pendingAction,
          plan: state.plan,
          prompt: args.prompt,
          repoContext: repoContextSummary,
          status: "paused",
          summary: error.approval.summary,
          verification: state.verification
        }
      });

      return resultFromSession(pausedSession);
    }

    if (error instanceof Error) {
      const failedSession = await persistSession({
        existingSession: args.existingSession,
        sessionHomeDir: args.sessionHomeDir,
        input: {
          approvals: state.approvals,
          artifacts: state.artifacts,
          changedFiles: [...state.changedFiles],
          config: resolvedConfig,
          cwd: args.cwd,
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
        }
      });

      return resultFromSession(failedSession);
    }

    throw error;
  }
}

async function runModelLoop(args: {
  client: ReturnType<typeof createOpenAICompatibleClient>;
  config: ResolvedExecutionConfig;
  cwd: string;
  prompt: string;
  repoContext: RepoContext;
  state: RuntimeState;
  verificationCommands: string[];
}): Promise<string> {
  const toolResult = await args.client.runTools({
    maxRounds: args.config.maxSteps ?? 8,
    systemPrompt: buildSystemPrompt(args.config),
    tools: [
      createWritePlanTool({
        getPlan: () => args.state.plan,
        setPlan: (nextPlan) => {
          args.state.plan = nextPlan;
        }
      }),
      createListFilesTool({
        cwd: args.cwd,
        observe: (observation) => {
          args.state.observations.push(observation);
        }
      }),
      createSearchFilesTool({
        cwd: args.cwd,
        observe: (observation) => {
          args.state.observations.push(observation);
        }
      }),
      createReadFileTool({
        cwd: args.cwd,
        observe: (observation) => {
          args.state.observations.push(observation);
        }
      }),
      createApplyPatchTool({
        addApproval: (approval) => {
          args.state.approvals = upsertApproval(args.state.approvals, approval);
        },
        addArtifacts: (artifacts) => {
          args.state.artifacts = upsertArtifacts(args.state.artifacts, artifacts);
        },
        addChangedFiles: (files) => {
          for (const file of files) {
            args.state.changedFiles.add(file);
          }
        },
        addObservation: (observation) => {
          args.state.observations.push(observation);
        },
        config: args.config,
        cwd: args.cwd
      }),
      createRunShellTool({
        addApproval: (approval) => {
          args.state.approvals = upsertApproval(args.state.approvals, approval);
        },
        addArtifacts: (artifacts) => {
          args.state.artifacts = upsertArtifacts(args.state.artifacts, artifacts);
        },
        addChangedFiles: (files) => {
          for (const file of files) {
            args.state.changedFiles.add(file);
          }
        },
        addObservation: (observation) => {
          args.state.observations.push(observation);
        },
        config: args.config,
        cwd: args.cwd,
        verificationCommands: args.verificationCommands
      })
    ],
    userPrompt: buildUserPrompt({
      cwd: args.cwd,
      prompt: args.prompt,
      repoContext: args.repoContext,
      state: args.state,
      verificationCommands: args.verificationCommands
    })
  });

  return toolResult.text;
}

async function executePendingAction(args: {
  config: ResolvedExecutionConfig;
  cwd: string;
  state: RuntimeState;
}): Promise<void> {
  if (args.state.pendingAction === null) {
    return;
  }

  const approvalId = args.state.pendingAction.approval.id;
  args.state.approvals = args.state.approvals.map((approval) =>
    approval.id === approvalId ? { ...approval, status: "approved" as const } : approval
  );

  if (args.state.pendingAction.tool === "apply_patch") {
    await applyPatchOperations({
      addArtifacts: (artifacts) => {
        args.state.artifacts = upsertArtifacts(args.state.artifacts, artifacts);
      },
      addChangedFiles: (files) => {
        for (const file of files) {
          args.state.changedFiles.add(file);
        }
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
        args.state.artifacts = upsertArtifacts(args.state.artifacts, artifacts);
      },
      addChangedFiles: (files) => {
        for (const file of files) {
          args.state.changedFiles.add(file);
        }
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

function createRuntimeState(source: {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: string[];
  observations: Observation[];
  pendingAction: PendingAction | null;
  plan: PlanState | null;
  repoContext: RepoContextSummary;
  verification: VerificationSummary;
}): RuntimeState {
  return {
    approvals: source.approvals,
    artifacts: source.artifacts,
    changedFiles: new Set(source.changedFiles),
    observations: source.observations,
    pendingAction: source.pendingAction,
    plan: source.plan,
    verification: source.verification
  };
}

function buildUserPrompt(args: {
  cwd: string;
  prompt: string;
  repoContext: RepoContext;
  state: RuntimeState;
  verificationCommands: string[];
}): string {
  const base = [
    "User task:",
    args.prompt,
    "",
    "Workspace summary:",
    `Working directory: ${args.cwd}`,
    args.repoContext.isGitRepo ? "Git repository detected." : "No git repository detected.",
    args.repoContext.guidanceFiles.length > 0
      ? `Guidance files: ${args.repoContext.guidanceFiles.join(", ")}.`
      : "No guidance files detected.",
    args.repoContext.topLevelEntries.length > 0
      ? `Workspace entries: ${args.repoContext.topLevelEntries.join(", ")}.`
      : "Workspace is empty.",
    Object.keys(args.repoContext.packageScripts).length > 0
      ? `Package scripts: ${Object.keys(args.repoContext.packageScripts).join(", ")}.`
      : "No package scripts detected.",
    args.verificationCommands.length > 0
      ? `Likely verification commands: ${args.verificationCommands.join(", ")}.`
      : "No verification commands inferred yet."
  ];

  if (args.state.plan) {
    base.push("", "Current plan:", serializePlan(args.state.plan));
  }

  if (args.state.changedFiles.size > 0) {
    base.push("", `Changed files so far: ${[...args.state.changedFiles].join(", ")}`);
  }

  if (args.state.observations.length > 0) {
    base.push("", "Known observations:");
    for (const observation of args.state.observations.slice(-8)) {
      base.push(`- ${observation.summary}`);
    }
  }

  for (const snippet of args.repoContext.snippets) {
    base.push("", `Snippet from ${snippet.path}:`, snippet.content);
  }

  return base.join("\n");
}

function buildSystemPrompt(config: ResolvedExecutionConfig): string {
  return [
    "You are a CLI coding agent.",
    "Investigate before editing.",
    "Use write_plan before the final answer.",
    "Use list_files, search_files, and read_file to gather context.",
    "Use apply_patch for file edits.",
    "Use run_shell for verification or necessary commands.",
    `Approval policy is ${config.approvalPolicy ?? "prompt"}.`,
    "Do not claim tests ran or files changed when they did not.",
    "If you make code changes, ensure verification is possible."
  ].join(" ");
}

function buildResumePrompt(session: SessionRecord): string {
  return [
    session.prompt,
    "",
    "Resuming previous session.",
    session.plan ? `Plan: ${serializePlan(session.plan)}` : "No stored plan.",
    session.changedFiles.length > 0
      ? `Changed files so far: ${session.changedFiles.join(", ")}.`
      : "No changed files yet.",
    session.observations.length > 0
      ? `Recent observations: ${session.observations
          .slice(-5)
          .map((observation) => observation.summary)
          .join(" | ")}`
      : "No prior observations."
  ].join("\n");
}

function buildVerificationFailurePrompt(args: {
  originalPrompt: string;
  state: RuntimeState;
}): string {
  const failedRuns = args.state.verification.runs.filter((run) => !run.passed);
  return [
    args.originalPrompt,
    "",
    "Verification failed. Investigate and repair the issue.",
    ...failedRuns.flatMap((run) => [
      `Command: ${run.command}`,
      `Exit code: ${run.exitCode}`,
      `stdout:\n${run.stdout}`,
      `stderr:\n${run.stderr}`
    ])
  ].join("\n");
}

function appendVerificationObservations(state: RuntimeState): void {
  for (const run of state.verification.runs) {
    state.observations.push({
      excerpt: [run.stdout, run.stderr].filter(Boolean).join("\n").trim(),
      query: run.command,
      summary: `Verification ${run.passed ? "passed" : "failed"}: ${run.command}`,
      tool: "run_shell"
    });
  }
}

async function persistSession(args: {
  existingSession: SessionRecord | null;
  input: {
    approvals: Approval[];
    artifacts: Artifact[];
    changedFiles: string[];
    config: ResolvedExecutionConfig;
    cwd: string;
    mode: "exec";
    nextActions: string[];
    observations: Observation[];
    pendingAction: PendingAction | null;
    plan: PlanState | null;
    prompt: string;
    repoContext: RepoContextSummary;
    status: "completed" | "failed" | "paused";
    summary: string;
    verification: VerificationSummary;
  };
  sessionHomeDir: string | undefined;
}): Promise<SessionRecord> {
  if (args.existingSession) {
    return updateSession(args.existingSession.id, args.input, args.sessionHomeDir);
  }

  return createSession(args.input, args.sessionHomeDir);
}

function deriveNextActions(plan: PlanState | null): string[] {
  if (!plan) {
    return [];
  }

  return plan.items
    .filter((item) => item.status !== "completed")
    .map((item) => item.content);
}

function serializePlan(plan: PlanState): string {
  return `${plan.summary} | ${plan.items
    .map((item) => `[${item.status}] ${item.content}`)
    .join(" ; ")}`;
}

function toRepoContextSummary(repoContext: RepoContext): RepoContextSummary {
  return {
    guidanceFiles: repoContext.guidanceFiles,
    isGitRepo: repoContext.isGitRepo,
    topLevelEntries: repoContext.topLevelEntries
  };
}

function upsertApproval(approvals: Approval[], approval: Approval): Approval[] {
  return [...approvals.filter((item) => item.id !== approval.id), approval];
}

function upsertArtifacts(current: Artifact[], next: Artifact[]): Artifact[] {
  const map = new Map(current.map((artifact) => [artifact.path, artifact]));
  for (const artifact of next) {
    map.set(artifact.path, artifact);
  }

  return [...map.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function buildFinalSummary(summary: string, verification: VerificationSummary): string {
  if (verification.runs.length === 0) {
    return summary;
  }

  const verificationLine = verification.passed
    ? `Verification passed: ${verification.runs.map((run) => run.command).join(", ")}`
    : `Verification failed: ${verification.runs
        .filter((run) => !run.passed)
        .map((run) => run.command)
        .join(", ")}`;

  return `${summary}\n\n${verificationLine}`;
}
