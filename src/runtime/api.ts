import type { ParsedOptions } from "../cli/parse.js";
import type { CommandResult, RuntimeObserver } from "./contracts.js";
import { loadConfig, resolveExecutionConfig, resolveLlmConfig } from "../config/load.js";
import { runExec } from "../app/exec.js";
import { runResume } from "../app/resume.js";
import { listRecentSessions, loadSession } from "../session/store.js";

export interface RuntimeEnvironment {
  fetchImpl?: typeof fetch;
  processCwd?: string;
  sessionHomeDir?: string;
}

export interface RuntimeDoctor {
  configPresent: boolean;
  defaultProfile: string | null;
  llmReady: boolean;
  model: string | null;
  profiles: string[];
  sessionHome: string;
}

export async function startTask(args: {
  environment?: RuntimeEnvironment;
  options: ParsedOptions;
  observer: RuntimeObserver | undefined;
  prompt: string;
}): Promise<CommandResult> {
  return runExec({
    fetchImpl: args.environment?.fetchImpl,
    observer: args.observer,
    options: args.options,
    processCwd: args.environment?.processCwd,
    prompt: args.prompt,
    sessionHomeDir: args.environment?.sessionHomeDir
  });
}

export async function resumeTask(args: {
  environment?: RuntimeEnvironment;
  options: ParsedOptions;
  observer: RuntimeObserver | undefined;
  sessionId?: string;
}): Promise<CommandResult | null> {
  return runResume({
    fetchImpl: args.environment?.fetchImpl,
    observer: args.observer,
    options: args.options,
    sessionHomeDir: args.environment?.sessionHomeDir,
    sessionId: args.sessionId
  });
}

export async function approveTask(args: {
  decision: "approve" | "reject";
  environment?: RuntimeEnvironment;
  observer: RuntimeObserver | undefined;
  options: ParsedOptions;
  sessionId: string;
}): Promise<CommandResult | null> {
  const session = await loadSession(args.sessionId, args.environment?.sessionHomeDir);

  if (!session) {
    return null;
  }

  return runResume({
    fetchImpl: args.environment?.fetchImpl,
    observer: args.observer,
    options: {
      ...args.options,
      approvalPolicy: args.decision === "approve" ? "auto" : "never"
    },
    sessionHomeDir: args.environment?.sessionHomeDir,
    sessionId: args.sessionId
  });
}

export async function listSessions(args: {
  environment?: RuntimeEnvironment;
  limit?: number;
}) {
  return listRecentSessions(args.limit ?? 5, args.environment?.sessionHomeDir);
}

export async function runDoctor(args: {
  environment?: RuntimeEnvironment;
  options: ParsedOptions;
}): Promise<RuntimeDoctor> {
  const config = await loadConfig(args.environment?.sessionHomeDir);
  const resolvedExecution = resolveExecutionConfig({
    cliOptions: args.options,
    config
  });

  let llmReady = false;
  let model: string | null = null;

  try {
    const llmConfig = resolveLlmConfig({
      config,
      executionConfig: resolvedExecution
    });
    llmReady = true;
    model = llmConfig.model;
  } catch {
    model = resolvedExecution.model ?? null;
  }

  return {
    configPresent: config !== null,
    defaultProfile: config?.defaultProfile ?? null,
    llmReady,
    model,
    profiles: config ? Object.keys(config.profiles).sort() : [],
    sessionHome: args.environment?.sessionHomeDir ?? "~/.coding-agent"
  };
}
