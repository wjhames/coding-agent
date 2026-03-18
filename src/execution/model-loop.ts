import { buildRequestContext } from "../app/context-builder.js";
import type { RepoContext } from "../app/context.js";
import type { LoadedGuidance } from "../app/guidance.js";
import { ApprovalRequiredError } from "../app/approval.js";
import type { ResolvedExecutionConfig } from "../config/load.js";
import { createOpenAICompatibleClient, type LlmTool } from "../llm/openai-client.js";
import type { Observation, RuntimeObserver } from "../runtime/contracts.js";
import { createApplyPatchTool } from "../tools/apply-patch.js";
import { createListFilesTool } from "../tools/list-files.js";
import { createReadFileTool } from "../tools/read-file.js";
import { createRunShellTool } from "../tools/run-shell.js";
import { createSearchFilesTool } from "../tools/search-files.js";
import { createWritePlanTool } from "../tools/write-plan.js";
import {
  addApproval,
  addArtifacts,
  addChangedFiles,
  addObservation,
  addVerificationRun,
  changedFilesList,
  recordAssistantTurn,
  setContextSnapshot,
  recordToolCallTurn,
  recordToolResultTurn,
  type ExecutionState
} from "./state.js";
import { sanitizeAssistantText } from "./completion.js";
import { buildSystemPrompt } from "./prompts.js";

export async function runModelLoop(args: {
  client: ReturnType<typeof createOpenAICompatibleClient>;
  config: ResolvedExecutionConfig;
  cwd: string;
  guidance: LoadedGuidance;
  observer: RuntimeObserver | undefined;
  prompt: string;
  readOnlyTask: boolean;
  repoContext: RepoContext;
  state: ExecutionState;
  verificationCommands: string[];
}): Promise<string> {
  const tools = createRuntimeTools({
    config: args.config,
    cwd: args.cwd,
    observer: args.observer,
    state: args.state,
    verificationCommands: args.verificationCommands
  });
  const requestContext = await buildRequestContext({
    changedFiles: changedFilesList(args.state),
    config: args.config,
    cwd: args.cwd,
    guidance: args.guidance.summary,
    observations: args.state.observations,
    pendingApprovalSummary: args.state.pendingAction?.approval.summary ?? null,
    plan: args.state.plan,
    prompt: args.prompt,
    repoContext: args.repoContext,
    systemPrompt: buildSystemPrompt({
      config: args.config,
      readOnlyTask: args.readOnlyTask
    }),
    turns: args.state.turns,
    verification: args.state.verification,
    verificationCommands: args.verificationCommands
  });
  setContextSnapshot(args.state, requestContext.context);
  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    context: requestContext.context,
    type: "context_updated"
  });
  const toolResult = await args.client.runTools({
    maxRounds: args.config.maxSteps ?? 8,
    messages: requestContext.messages,
    onTextDelta(delta) {
      emitRuntimeEvent(args.observer, {
        at: new Date().toISOString(),
        delta,
        type: "assistant_delta"
      });
    },
    tools
  });

  const sanitizedText = sanitizeAssistantText(toolResult.text);
  recordAssistantTurn(args.state, sanitizedText);
  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    text: sanitizedText,
    type: "assistant_message"
  });

  return sanitizedText;
}

export function emitRuntimeEvent(
  observer: RuntimeObserver | undefined,
  event: Parameters<RuntimeObserver["onEvent"]>[0]
): void {
  observer?.onEvent(event);
}

function createRuntimeTools(args: {
  config: ResolvedExecutionConfig;
  cwd: string;
  observer: RuntimeObserver | undefined;
  state: ExecutionState;
  verificationCommands: string[];
}): LlmTool[] {
  return [
    createWritePlanTool({
      getPlan: () => args.state.plan,
      setPlan: (nextPlan) => {
        args.state.plan = nextPlan;
        emitRuntimeEvent(args.observer, {
          at: new Date().toISOString(),
          plan: nextPlan,
          type: "plan_updated"
        });
      }
    }),
    createListFilesTool({
      cwd: args.cwd,
      observe: (observation) => {
        addObservation(args.state, observation);
      }
    }),
    createSearchFilesTool({
      cwd: args.cwd,
      observe: (observation) => {
        addObservation(args.state, observation);
      }
    }),
    createReadFileTool({
      cwd: args.cwd,
      observe: (observation) => {
        addObservation(args.state, observation);
      }
    }),
    createApplyPatchTool({
      addApproval: (approval) => {
        addApproval(args.state, approval);
      },
      addArtifacts: (artifacts) => {
        addArtifacts(args.state, artifacts);
      },
      addChangedFiles: (files) => {
        addChangedFiles(args.state, files);
      },
      addObservation: (observation) => {
        addObservation(args.state, observation);
      },
      config: args.config,
      cwd: args.cwd
    }),
    createRunShellTool({
      addApproval: (approval) => {
        addApproval(args.state, approval);
      },
      addArtifacts: (artifacts) => {
        addArtifacts(args.state, artifacts);
      },
      addChangedFiles: (files) => {
        addChangedFiles(args.state, files);
      },
      addObservation: (observation) => {
        addObservation(args.state, observation);
      },
      addVerificationRun: (run) => {
        addVerificationRun(args.state, run);
      },
      config: args.config,
      cwd: args.cwd,
      verificationCommands: args.verificationCommands
    })
  ].map((tool) =>
    wrapToolWithEvents({
      observer: args.observer,
      state: args.state,
      tool
    })
  );
}

function wrapToolWithEvents(args: {
  observer: RuntimeObserver | undefined;
  state: ExecutionState;
  tool: LlmTool;
}): LlmTool {
  return {
    ...args.tool,
    async run(input) {
      const inputSummary = summarizeToolInput(input);
      const toolName = normalizeToolName(args.tool.name);
      recordToolCallTurn(args.state, inputSummary, toolName);
      emitRuntimeEvent(args.observer, {
        at: new Date().toISOString(),
        inputSummary,
        tool: toolName,
        type: "tool_called"
      });
      emitToolStatus(args.observer, args.tool.name);
      const beforeObservationCount = args.state.observations.length;
      const beforeArtifactCount = args.state.artifacts.length;
      const beforeChangedFiles = new Set(args.state.changedFiles);

      try {
        const result = await args.tool.run(input);
        const latestObservation =
          args.state.observations.length > beforeObservationCount
            ? args.state.observations.at(-1)
            : undefined;
        const newArtifacts = args.state.artifacts.slice(beforeArtifactCount);
        const newChangedFiles = changedFilesList(args.state).filter(
          (path) => !beforeChangedFiles.has(path)
        );
        recordToolResultTurn({
          ...(newChangedFiles.length > 0 ? { changedFiles: newChangedFiles } : {}),
          ...(latestObservation?.path ? { paths: [latestObservation.path] } : {}),
          state: args.state,
          summary:
            latestObservation?.summary ??
            (newChangedFiles.length > 0
              ? `Updated ${newChangedFiles.join(", ")}.`
              : `${toolName} completed.`),
          tool: toolName
        });
        emitRuntimeEvent(args.observer, {
          ...(args.state.observations.length > beforeObservationCount && latestObservation
            ? { observation: latestObservation }
            : {}),
          ...(newArtifacts.length > 0 ? { artifacts: newArtifacts } : {}),
          ...(newChangedFiles.length > 0 ? { changedFiles: newChangedFiles } : {}),
          at: new Date().toISOString(),
          tool: toolName,
          type: "tool_result"
        });
        return result;
      } catch (error) {
        if (error instanceof ApprovalRequiredError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : "Unknown tool failure.";
        const observableTool = toObservationToolName(args.tool.name);
        const observation: Observation | null =
          observableTool === null
            ? null
            : {
                excerpt: message,
                summary: `Tool error from ${args.tool.name}: ${message}`,
                tool: observableTool
              };

        if (observation) {
          addObservation(args.state, observation);
        }
        recordToolResultTurn({
          error: message,
          ...("path" in (observation ?? {}) && observation?.path ? { paths: [observation.path] } : {}),
          state: args.state,
          summary: observation?.summary ?? `Tool error from ${args.tool.name}: ${message}`,
          tool: toolName
        });
        emitRuntimeEvent(args.observer, {
          at: new Date().toISOString(),
          error: message,
          ...(observation ? { observation } : {}),
          tool: toolName,
          type: "tool_result"
        });

        return JSON.stringify({
          ok: false,
          error: "tool_error",
          message
        });
      }
    }
  };
}

function emitToolStatus(
  observer: RuntimeObserver | undefined,
  toolName: string
): void {
  const tool = normalizeToolName(toolName);
  const status =
    tool === "apply_patch"
      ? "editing"
      : tool === "run_shell"
        ? "verifying"
        : tool === "write_plan"
          ? "planning"
          : "reading";
  const detail =
    tool === "apply_patch"
      ? "Applying changes."
      : tool === "run_shell"
        ? "Running command."
        : undefined;
  emitRuntimeEvent(observer, {
    at: new Date().toISOString(),
    ...(detail ? { detail } : {}),
    status,
    type: "status"
  });
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
