import { resolve } from "node:path";
import type { CommandResult, PlanState, RepoContextSummary } from "../cli/output.js";
import { collectRepoContext, type RepoContext } from "./context.js";
import { inferVerificationCommands } from "./verification.js";
import {
  loadConfig,
  resolveExecutionConfig,
  resolveLlmConfig
} from "../config/load.js";
import type { ParsedOptions } from "../cli/parse.js";
import { createOpenAICompatibleClient } from "../llm/openai.js";
import { createSession } from "../session/store.js";
import { createWritePlanTool } from "../tools/write-plan.js";

export async function runExec(args: {
  fetchImpl: typeof fetch | undefined;
  options: ParsedOptions;
  prompt: string;
  processCwd: string | undefined;
  sessionHomeDir: string | undefined;
}): Promise<CommandResult> {
  const cwd = resolve(args.processCwd ?? process.cwd(), args.options.cwd ?? ".");
  const config = await loadConfig(args.sessionHomeDir);
  const resolvedConfig = resolveExecutionConfig({
    cliOptions: args.options,
    config
  });
  const llmConfig = resolveLlmConfig({
    config,
    executionConfig: resolvedConfig
  });
  const repoContext = await collectRepoContext(cwd);
  const verificationCommands = inferVerificationCommands({
    packageScripts: repoContext.packageScripts
  });
  let plan: PlanState | null = null;
  const client = createOpenAICompatibleClient({
    apiKey: llmConfig.apiKey,
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {})
  });
  const toolResult = await client.runTools({
    systemPrompt: buildSystemPrompt(),
    tools: [
      createWritePlanTool({
        getPlan: () => plan,
        setPlan: (nextPlan) => {
          plan = nextPlan;
        }
      })
    ],
    userPrompt: buildUserPrompt({
      cwd,
      prompt: args.prompt,
      repoContext,
      verificationCommands
    })
  });
  const nextActions = deriveNextActions(plan);
  const repoContextSummary: RepoContextSummary = {
    guidanceFiles: repoContext.guidanceFiles,
    isGitRepo: repoContext.isGitRepo,
    topLevelEntries: repoContext.topLevelEntries
  };
  const session = await createSession(
    {
      config: resolvedConfig,
      cwd,
      mode: "exec",
      nextActions,
      plan,
      prompt: args.prompt,
      repoContext: repoContextSummary,
      status: "completed",
      summary: toolResult.text,
      verification: {
        commands: verificationCommands,
        inferred: true,
        passed: false
      }
    },
    args.sessionHomeDir
  );

  return {
    artifacts: session.artifacts,
    verification: session.verification,
    approvals: session.approvals,
    changedFiles: session.changedFiles,
    exitCode: 0,
    nextActions: session.nextActions,
    plan: session.plan,
    repoContext: session.repoContext,
    sessionId: session.id,
    status: session.status,
    summary: session.summary
  };
}

function buildUserPrompt(args: {
  cwd: string;
  prompt: string;
  repoContext: RepoContext;
  verificationCommands: string[];
}): string {
  const repoLine = args.repoContext.isGitRepo
    ? "Git repository detected."
    : "No git repository detected.";
  const guidanceLine =
    args.repoContext.guidanceFiles.length > 0
      ? `Guidance files: ${args.repoContext.guidanceFiles.join(", ")}.`
      : "No guidance files detected.";
  const entriesLine =
    args.repoContext.topLevelEntries.length > 0
      ? `Workspace entries: ${args.repoContext.topLevelEntries.join(", ")}.`
      : "Workspace is empty.";
  const scriptsLine =
    Object.keys(args.repoContext.packageScripts).length > 0
      ? `Package scripts: ${Object.keys(args.repoContext.packageScripts).join(", ")}.`
      : "No package scripts detected.";
  const verificationLine =
    args.verificationCommands.length > 0
      ? `Likely verification commands: ${args.verificationCommands.join(", ")}.`
      : "No verification commands inferred yet.";

  return [
    "User task:",
    args.prompt,
    "",
    "Workspace summary:",
    `Working directory: ${args.cwd}`,
    repoLine,
    guidanceLine,
    entriesLine,
    scriptsLine,
    verificationLine,
    ...args.repoContext.snippets.flatMap((snippet) => [
      "",
      `Snippet from ${snippet.path}:`,
      snippet.content
    ])
  ].join("\n");
}

function buildSystemPrompt(): string {
  return [
    "You are a CLI coding agent.",
    "You have not edited files yet and must not claim to have done so.",
    "You must call the write_plan tool before your final response.",
    "Use the plan to capture a short concrete todo list for the task.",
    "After calling the tool, produce a concise execution summary and immediate next actions.",
    "Do not claim tests ran or files changed when they did not."
  ].join(" ");
}

function deriveNextActions(plan: PlanState | null): string[] {
  if (!plan) {
    return [];
  }

  return plan.items
    .filter((item) => item.status !== "completed")
    .map((item) => item.content);
}
