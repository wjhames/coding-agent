import { runVerificationCommands } from "../app/verification-runner.js";
import { summarizeVerificationEvidence } from "../app/verification.js";
import type { RuntimeObserver, VerificationRun } from "../runtime/contracts.js";
import { recordSystemNote, type ExecutionState } from "./state.js";
import { buildVerificationFailurePrompt } from "./prompts.js";
import { emitRuntimeEvent, runModelLoop } from "./model-loop.js";
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

  args.state.verification = summarizeVerificationEvidence({
    commands: args.verificationCommands,
    runs: args.state.verification.runs,
    skippedCommands: args.skippedCommands
  });

  if (args.verificationCommands.length === 0) {
    return { summary };
  }

  if (args.state.verification.status === "not_run") {
    await runVerificationPass({
      commands: args.verificationCommands,
      cwd: args.cwd,
      observer: args.observer,
      skippedCommands: args.skippedCommands,
      state: args.state
    });
  }

  const maxRepairAttempts = Math.max(1, Math.min(3, args.config.maxSteps ?? 3));
  let repairAttempts = 0;

  while (args.state.verification.status === "failed" && repairAttempts < maxRepairAttempts) {
    repairAttempts += 1;
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

    await runVerificationPass({
      commands: args.verificationCommands,
      cwd: args.cwd,
      observer: args.observer,
      skippedCommands: args.skippedCommands,
      state: args.state
    });
  }

  return { summary };
}

export function appendVerificationObservations(args: {
  runs: VerificationRun[];
  state: ExecutionState;
}): void {
  for (const run of args.runs) {
    args.state.observations.push({
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
  const previousCount = args.state.verification.runs.length;
  args.state.verification = summarizeVerificationEvidence({
    commands: args.commands,
    runs: [...args.state.verification.runs, ...verification.runs],
    skippedCommands: args.skippedCommands
  });
  const newRuns = args.state.verification.runs.slice(previousCount);

  recordSystemNote(
    args.state,
    args.state.verification.status === "passed"
      ? `Verification passed: ${args.state.verification.runs.map((run) => run.command).join(", ")}`
      : args.state.verification.status === "failed"
        ? `Verification failed: ${args.state.verification.runs
            .filter((run) => !run.passed)
            .map((run) => run.command)
            .join(", ")}`
        : `Verification not run: ${args.state.verification.notRunReason ?? "unknown"}`
  );
  emitRuntimeEvent(args.observer, {
    at: new Date().toISOString(),
    type: "verification_completed",
    verification: args.state.verification
  });
  appendVerificationObservations({
    runs: newRuns,
    state: args.state
  });
  return args.state.verification;
}
