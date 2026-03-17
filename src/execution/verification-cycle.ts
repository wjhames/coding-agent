import { runVerificationCommands } from "../app/verification-runner.js";
import type { RuntimeObserver } from "../runtime/contracts.js";
import {
  changedFilesList,
  recordSystemNote,
  type ExecutionState
} from "./state.js";
import { buildVerificationFailurePrompt } from "./prompts.js";
import { runModelLoop, emitRuntimeEvent } from "./model-loop.js";
import type { RepoContext } from "../app/context.js";
import type { LoadedGuidance } from "../app/guidance.js";
import type { ResolvedExecutionConfig } from "../config/load.js";
import { createOpenAICompatibleClient } from "../llm/openai-client.js";

export async function runVerificationCycle(args: {
  client: ReturnType<typeof createOpenAICompatibleClient>;
  config: ResolvedExecutionConfig;
  cwd: string;
  guidance: LoadedGuidance;
  observer: RuntimeObserver | undefined;
  originalPrompt: string;
  repoContext: RepoContext;
  skippedCommands: Array<{ command: string; reason: string }>;
  state: ExecutionState;
  verificationCommands: string[];
}): Promise<{ summary: string }> {
  let summary = "";

  if (changedFilesList(args.state).length > 0 && args.verificationCommands.length > 0) {
    args.state.verification = await runVerificationPass({
      commands: args.verificationCommands,
      cwd: args.cwd,
      observer: args.observer,
      skippedCommands: args.skippedCommands,
      state: args.state
    });

    if (!args.state.verification.passed) {
      emitRuntimeEvent(args.observer, {
        at: new Date().toISOString(),
        detail: "Repairing after failed verification",
        status: "editing",
        type: "status"
      });
      summary = await runModelLoop({
        client: args.client,
        config: args.config,
        cwd: args.cwd,
        guidance: args.guidance,
        observer: args.observer,
        prompt: buildVerificationFailurePrompt({
          originalPrompt: args.originalPrompt,
          state: args.state
        }),
        readOnlyTask: false,
        repoContext: args.repoContext,
        state: args.state,
        verificationCommands: args.verificationCommands
      });

      args.state.verification = await runVerificationPass({
        commands: args.verificationCommands,
        cwd: args.cwd,
        observer: args.observer,
        skippedCommands: args.skippedCommands,
        state: args.state
      });
    }
  } else {
    args.state.verification = {
      commands: args.verificationCommands,
      inferred: true,
      notRunReason:
        changedFilesList(args.state).length === 0
          ? "No file changes were made."
          : "No verification commands were inferred.",
      passed: false,
      ran: false,
      runs: [],
      selectedCommands: args.verificationCommands,
      skippedCommands: args.skippedCommands,
      status: "not_run"
    };
  }

  return { summary };
}

export function appendVerificationObservations(state: ExecutionState): void {
  for (const run of state.verification.runs) {
    state.observations.push({
      excerpt: [run.stdout, run.stderr].filter(Boolean).join("\n").trim(),
      query: run.command,
      summary: `Verification ${run.passed ? "passed" : "failed"}: ${run.command}`,
      tool: "run_shell"
    });
  }
}

async function runVerificationPass(args: {
  commands: string[];
  cwd: string;
  observer: RuntimeObserver | undefined;
  skippedCommands: Array<{ command: string; reason: string }>;
  state: ExecutionState;
}) {
  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    detail: args.commands.join(", "),
    status: "verifying",
    type: "status"
  });
  recordSystemNote(args.state, `Verification started: ${args.commands.join(", ")}`);
  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    commands: args.commands,
    type: "verification_started"
  });
  const verification = await runVerificationCommands({
    commands: args.commands,
    cwd: args.cwd,
    skippedCommands: args.skippedCommands
  });
  recordSystemNote(
    args.state,
    verification.status === "passed"
      ? `Verification passed: ${verification.runs.map((run) => run.command).join(", ")}`
      : verification.status === "failed"
        ? `Verification failed: ${verification.runs
            .filter((run) => !run.passed)
            .map((run) => run.command)
            .join(", ")}`
        : `Verification not run: ${verification.notRunReason ?? "unknown"}`
  );
  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    type: "verification_completed",
    verification
  });
  args.state.verification = verification;
  appendVerificationObservations(args.state);
  return verification;
}
