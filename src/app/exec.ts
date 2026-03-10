import { resolve } from "node:path";
import type {
  Approval,
  Artifact,
  CommandResult,
  CompactionSummary,
  GuidanceSummary,
  MemorySummary,
  Observation,
  PlanState,
  RepoContextSummary,
  VerificationSummary
} from "../cli/output.js";
import { ApprovalDeniedError, ApprovalRequiredError, type PendingAction } from "./approval.js";
import { deriveCompaction } from "./compaction.js";
import { collectRepoContext, type RepoContext } from "./context.js";
import { buildExecutionContext } from "./context-builder.js";
import { loadGuidance, type LoadedGuidance } from "./guidance.js";
import { deriveMemory } from "./memory.js";
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
import type { LlmTool } from "../llm/openai.js";
import type { SessionRecord } from "../session/store.js";
import { createSession, updateSession } from "../session/store.js";
import {
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createCompactionUpdatedEvent,
  createMemoryUpdatedEvent,
  createPlanUpdatedEvent,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionPausedEvent,
  createSummaryUpdatedEvent,
  createToolCalledEvent,
  createToolResultRecordedEvent,
  createVerificationCompletedEvent,
  createVerificationStartedEvent,
  type SessionEvent
} from "../session/events.js";
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
  compaction: CompactionSummary;
  events: SessionEvent[];
  guidance: GuidanceSummary;
  memory: MemorySummary;
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
    const rejectionEvent = createApprovalResolvedEvent({
      approvalId: args.session.pendingAction.approval.id,
      status: "rejected"
    });
    const memory = deriveMemory({
      approvals: args.session.approvals.map((approval) =>
        approval.id === args.session.pendingAction?.approval.id
          ? { ...approval, status: "rejected" as const }
          : approval
      ),
      artifacts: args.session.artifacts,
      changedFiles: args.session.changedFiles,
      observations: args.session.observations,
      plan: args.session.plan,
      verification: args.session.verification
    });
    const compaction = deriveCompaction({
      changedFiles: args.session.changedFiles,
      events: [],
      observations: args.session.observations,
      verification: args.session.verification
    });
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
        compaction,
        config: args.session.config,
        cwd: args.session.cwd,
        eventCount: args.session.eventCount,
        events: [
          rejectionEvent,
          createMemoryUpdatedEvent(memory),
          createCompactionUpdatedEvent(compaction)
        ],
        guidance: args.session.guidance,
        lastEventAt: rejectionEvent.at,
        memory,
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
  const readOnlyTask = isLikelyReadOnlyTask(args.prompt);
  const guidance = await loadGuidance({
    cwd: args.cwd,
    homeDir: args.sessionHomeDir,
    prompt: args.prompt,
    repoGuidanceFiles: repoContext.guidanceFiles
  });
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
      compaction: {
        changedFilesSummary: null,
        eventSummary: null,
        observationSummary: null,
        verificationSummary: null
      },
      guidance: {
        activeRules: guidance.summary.activeRules,
        sources: guidance.summary.sources
      },
      memory: {
        artifacts: [],
        decisions: [],
        working: []
      },
      observations: [],
      pendingAction: null,
      plan: null,
      repoContext: repoContextSummary,
      verification: {
        commands: verificationCommands,
        inferred: true,
        notRunReason: "Verification has not run yet.",
        passed: false,
        ran: false,
        runs: [],
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
    const initialSummary = await runModelLoop({
      client,
      config: resolvedConfig,
      cwd: args.cwd,
      prompt: args.prompt,
      guidance,
      readOnlyTask,
      repoContext,
      state,
      verificationCommands
    });

    let summary = initialSummary;

    if (state.changedFiles.size > 0 && verificationCommands.length > 0) {
      state.events.push(createVerificationStartedEvent(verificationCommands));
      state.verification = await runVerificationCommands({
        commands: verificationCommands,
        cwd: args.cwd
      });
      state.events.push(createVerificationCompletedEvent(state.verification));
      appendVerificationObservations(state);
      syncDerivedState(state);

      if (!state.verification.passed) {
        summary = await runModelLoop({
          client,
          config: resolvedConfig,
          cwd: args.cwd,
          prompt: buildVerificationFailurePrompt({
            originalPrompt: args.prompt,
            state
          }),
          guidance,
          readOnlyTask: false,
          repoContext,
          state,
          verificationCommands
        });
        state.events.push(createVerificationStartedEvent(verificationCommands));
        state.verification = await runVerificationCommands({
          commands: verificationCommands,
          cwd: args.cwd
        });
        state.events.push(createVerificationCompletedEvent(state.verification));
        appendVerificationObservations(state);
        syncDerivedState(state);
      }
    } else {
      state.verification = {
        commands: verificationCommands,
        inferred: true,
        notRunReason:
          state.changedFiles.size === 0
            ? "No file changes were made."
            : "No verification commands were inferred.",
        passed: false,
        ran: false,
        runs: [],
        status: "not_run"
      };
      syncDerivedState(state);
    }

    syncDerivedState(state);
    const nextActions = deriveNextActions(state.plan);
    const status = state.verification.status === "failed" ? "failed" : "completed";
    const finalSummary = buildFinalSummary(summary, {
      changedFiles: [...state.changedFiles],
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
            changedFiles: [...state.changedFiles],
            pendingAction: null,
            summary: finalSummary,
            verification: state.verification
          })
        : createSessionFailedEvent({
            approvals: state.approvals,
            artifacts: state.artifacts,
            changedFiles: [...state.changedFiles],
            pendingAction: null,
            summary: finalSummary,
            verification: state.verification
          })
    );
    const persisted = await persistSession({
      existingSession: args.existingSession,
      sessionHomeDir: args.sessionHomeDir,
      input: {
        approvals: state.approvals,
        artifacts: state.artifacts,
        changedFiles: [...state.changedFiles],
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
      }
    });

    return resultFromSession(persisted);
  } catch (error) {
    if (error instanceof ApprovalRequiredError) {
      state.pendingAction = error.action;
      state.approvals = upsertApproval(state.approvals, error.approval);
      state.events.push(
        createApprovalRequestedEvent({
          approval: error.approval,
          pendingAction: error.action
        })
      );
      syncDerivedState(state);
      state.events.push(
        createSummaryUpdatedEvent({
          nextActions: deriveNextActions(state.plan),
          summary: error.approval.summary
        })
      );
      state.events.push(
        createSessionPausedEvent({
          approvals: state.approvals,
          artifacts: state.artifacts,
          changedFiles: [...state.changedFiles],
          pendingAction: state.pendingAction,
          summary: error.approval.summary,
          verification: state.verification
        })
      );
      const pausedSession = await persistSession({
        existingSession: args.existingSession,
        sessionHomeDir: args.sessionHomeDir,
        input: {
          approvals: state.approvals,
          artifacts: state.artifacts,
          changedFiles: [...state.changedFiles],
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
          summary: error.approval.summary,
          verification: state.verification
        }
      });

      return resultFromSession(pausedSession);
    }

    if (error instanceof Error) {
      syncDerivedState(state);
      const failedSession = await persistSession({
        existingSession: args.existingSession,
        sessionHomeDir: args.sessionHomeDir,
        input: {
          approvals: state.approvals,
          artifacts: state.artifacts,
          changedFiles: [...state.changedFiles],
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
              changedFiles: [...state.changedFiles],
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
  guidance: LoadedGuidance;
  readOnlyTask: boolean;
  repoContext: RepoContext;
  state: RuntimeState;
  verificationCommands: string[];
}): Promise<string> {
  const tools = createRuntimeTools({
    config: args.config,
    cwd: args.cwd,
    state: args.state,
    verificationCommands: args.verificationCommands
  });
  const toolResult = await args.client.runTools({
    maxRounds: args.config.maxSteps ?? 8,
    systemPrompt: buildSystemPrompt({
      config: args.config,
      readOnlyTask: args.readOnlyTask
    }),
    tools,
    userPrompt: buildExecutionContext({
      changedFiles: [...args.state.changedFiles],
      compaction: args.state.compaction,
      cwd: args.cwd,
      guidance: args.guidance,
      memory: args.state.memory,
      observations: args.state.observations,
      plan: args.state.plan,
      prompt: args.prompt,
      readOnlyTask: args.readOnlyTask,
      repoContext: args.repoContext,
      verificationCommands: args.verificationCommands
    })
  });

  return toolResult.text;
}

function createRuntimeTools(args: {
  config: ResolvedExecutionConfig;
  cwd: string;
  state: RuntimeState;
  verificationCommands: string[];
}): LlmTool[] {
  return [
    createWritePlanTool({
      getPlan: () => args.state.plan,
      setPlan: (nextPlan) => {
        args.state.plan = nextPlan;
        args.state.events.push(createPlanUpdatedEvent(nextPlan));
        syncDerivedState(args.state);
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
  ].map((tool) =>
    wrapToolWithEvents({
      state: args.state,
      tool
    })
  );
}

function wrapToolWithEvents(args: {
  state: RuntimeState;
  tool: LlmTool;
}): LlmTool {
  return {
    ...args.tool,
    async run(input) {
      args.state.events.push(
        createToolCalledEvent({
          inputSummary: summarizeToolInput(input),
          tool: normalizeToolName(args.tool.name)
        })
      );
      const beforeObservationCount = args.state.observations.length;
      const beforeArtifactCount = args.state.artifacts.length;
      const beforeChangedFiles = new Set(args.state.changedFiles);
      let result: string;

      try {
        result = await args.tool.run(input);
      } catch (error) {
        if (error instanceof ApprovalRequiredError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : "Unknown tool failure.";
        const observableTool = toObservationToolName(args.tool.name);
        const observation =
          observableTool === null
            ? null
            : ({
                excerpt: message,
                summary: `Tool error from ${args.tool.name}: ${message}`,
                tool: observableTool
              } satisfies Observation);

        if (observation) {
          args.state.observations.push(observation);
        }
        args.state.events.push(
          createToolResultRecordedEvent({
            ...(observation ? { observation } : {}),
            tool: normalizeToolName(args.tool.name)
          })
        );
        syncDerivedState(args.state);

        return JSON.stringify({
          ok: false,
          error: "tool_error",
          message
        });
      }

      const latestObservation = args.state.observations.at(-1);
      const newArtifacts = args.state.artifacts.slice(beforeArtifactCount);
      const newChangedFiles = [...args.state.changedFiles].filter(
        (path) => !beforeChangedFiles.has(path)
      );
      args.state.events.push(
        createToolResultRecordedEvent({
          ...(args.state.observations.length > beforeObservationCount && latestObservation
            ? { observation: latestObservation }
            : {}),
          ...(newArtifacts.length > 0 ? { artifacts: newArtifacts } : {}),
          ...(newChangedFiles.length > 0 ? { changedFiles: newChangedFiles } : {}),
          tool: normalizeToolName(args.tool.name)
        })
      );
      syncDerivedState(args.state);
      return result;
    }
  };
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
  args.state.events.push(
    createApprovalResolvedEvent({
      approvalId,
      status: "approved"
    })
  );
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
  syncDerivedState(args.state);
}

function createRuntimeState(source: {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: string[];
  compaction: CompactionSummary;
  guidance: GuidanceSummary;
  memory: MemorySummary;
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
    compaction: source.compaction,
    events: [],
    guidance: source.guidance,
    memory: source.memory,
    observations: source.observations,
    pendingAction: source.pendingAction,
    plan: source.plan,
    verification: source.verification
  };
}

function buildSystemPrompt(args: {
  config: ResolvedExecutionConfig;
  readOnlyTask: boolean;
}): string {
  return [
    "You are a CLI coding agent.",
    "Investigate before editing.",
    args.readOnlyTask
      ? "This is a read-only task. Do not edit files or run verification unless the user explicitly asks."
      : "Edit files only when the task requires it.",
    args.readOnlyTask
      ? "Keep read-only summaries concise and grounded in files or command output you actually inspected."
      : "Keep summaries grounded in files or command output you actually inspected.",
    "Prefer list_files and search_files before read_file when locating code.",
    "Use workspace-relative paths for file tools unless the user explicitly gave an absolute file path.",
    "Do not call read_file on directories; use list_files for directories.",
    "Prefer file tools over run_shell for repository inspection.",
    "Use write_plan before the final answer.",
    "Use list_files, search_files, and read_file to gather context.",
    "Use apply_patch for file edits.",
    "Use run_shell for verification or necessary commands.",
    "If a tool returns an error, adapt and continue rather than repeating the same failing call.",
    "Avoid heavy or ignored directories like node_modules, dist, coverage, and .notes unless the task requires them.",
    `Approval policy is ${args.config.approvalPolicy ?? "prompt"}.`,
    "Do not claim tests ran or files changed when they did not.",
    "Do not speculate about test failures, implementation gaps, or repository state that you did not directly observe.",
    "If something was not inspected, say so instead of guessing.",
    "If you make code changes, ensure verification is possible."
  ].join(" ");
}

function summarizeToolInput(input: unknown): string {
  const serialized = JSON.stringify(input);

  if (!serialized) {
    return "";
  }

  return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized;
}

function normalizeToolName(name: string):
  | "apply_patch"
  | "list_files"
  | "read_file"
  | "run_shell"
    | "search_files"
    | "write_plan" {
  return name as
    | "apply_patch"
    | "list_files"
    | "read_file"
    | "run_shell"
    | "search_files"
    | "write_plan";
}

function toObservationToolName(name: string): Observation["tool"] | null {
  if (name === "write_plan") {
    return null;
  }

  return name as Observation["tool"];
}

function buildResumePrompt(session: SessionRecord): string {
  return [
    session.prompt,
    "",
    "Resuming previous session.",
    session.plan ? `Plan: ${serializePlan(session.plan)}` : "No stored plan.",
    session.compaction.observationSummary
      ? `Compaction: ${session.compaction.observationSummary}`
      : "No compaction summary yet.",
    session.memory.working.length > 0
      ? `Working memory: ${session.memory.working.map((entry) => entry.summary).join(" | ")}`
      : "No working memory yet.",
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

function isLikelyReadOnlyTask(prompt: string): boolean {
  const lowered = prompt.toLowerCase();
  const writeIntent = [
    "fix",
    "change",
    "edit",
    "update",
    "modify",
    "create",
    "write",
    "delete",
    "remove",
    "rename",
    "refactor",
    "implement",
    "patch",
    "add "
  ];

  if (writeIntent.some((token) => lowered.includes(token))) {
    return false;
  }

  const readOnlyIntent = [
    "inspect",
    "summarize",
    "summary",
    "explain",
    "review",
    "analyze",
    "analyse",
    "understand",
    "describe",
    "walk through",
    "what does"
  ];

  return readOnlyIntent.some((token) => lowered.includes(token));
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

function syncMemory(state: RuntimeState): void {
  const nextMemory = deriveMemory({
    approvals: state.approvals,
    artifacts: state.artifacts,
    changedFiles: [...state.changedFiles],
    observations: state.observations,
    plan: state.plan,
    verification: state.verification
  });

  if (JSON.stringify(state.memory) === JSON.stringify(nextMemory)) {
    return;
  }

  state.memory = nextMemory;
  state.events.push(createMemoryUpdatedEvent(nextMemory));
}

function syncCompaction(state: RuntimeState): void {
  const nextCompaction = deriveCompaction({
    changedFiles: [...state.changedFiles],
    events: state.events,
    observations: state.observations,
    verification: state.verification
  });

  if (JSON.stringify(state.compaction) === JSON.stringify(nextCompaction)) {
    return;
  }

  state.compaction = nextCompaction;
  state.events.push(createCompactionUpdatedEvent(nextCompaction));
}

function syncDerivedState(state: RuntimeState): void {
  syncMemory(state);
  syncCompaction(state);
}

async function persistSession(args: {
  existingSession: SessionRecord | null;
  input: {
    approvals: Approval[];
    artifacts: Artifact[];
    changedFiles: string[];
    compaction: CompactionSummary;
    config: ResolvedExecutionConfig;
    cwd: string;
    events: SessionEvent[];
    guidance: GuidanceSummary;
    memory: MemorySummary;
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

function buildFinalSummary(
  summary: string,
  details: {
    changedFiles: string[];
    verification: VerificationSummary;
  }
): string {
  const lines = [summary];

  if (details.changedFiles.length > 0) {
    lines.push(`Changed files: ${details.changedFiles.join(", ")}`);
  }

  if (details.verification.status === "passed") {
    lines.push(`Verification passed: ${details.verification.runs.map((run) => run.command).join(", ")}`);
  } else if (details.verification.status === "failed") {
    lines.push(
      `Verification failed: ${details.verification.runs
        .filter((run) => !run.passed)
        .map((run) => run.command)
        .join(", ")}`
    );
  } else if (details.verification.notRunReason) {
    lines.push(`Verification not run: ${details.verification.notRunReason}`);
  }

  return lines.join("\n\n");
}
