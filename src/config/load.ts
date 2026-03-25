import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedOptions } from "../cli/parse.js";
import { getAgentHome } from "../session/paths.js";
import {
  approvalPolicySchema,
  configSchema,
  type CodingAgentConfig,
  type CodingAgentProfile
} from "./schema.js";

export const DEFAULT_CONFIG_FILE = "config.json";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface ResolvedExecutionConfig {
  approvalPolicy: CodingAgentProfile["approvalPolicy"];
  baseUrl: string | undefined;
  contextWindowTokens: number | undefined;
  maxSteps: number | undefined;
  model: string | undefined;
  networkEgress: boolean | undefined;
  profileName: string | undefined;
  timeout: string | undefined;
}

export class ConfigError extends Error {}

export async function loadConfig(
  homeDir?: string,
  fileName = DEFAULT_CONFIG_FILE
): Promise<CodingAgentConfig | null> {
  const path = join(getAgentHome(homeDir), fileName);

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return configSchema.parse(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    if (error instanceof SyntaxError) {
      throw new ConfigError(`Invalid JSON in ${fileName}.`);
    }

    throw new ConfigError(normalizeConfigError(error, fileName));
  }
}

export function resolveExecutionConfig(args: {
  cliOptions: ParsedOptions;
  config: CodingAgentConfig | null;
}): ResolvedExecutionConfig {
  const { cliOptions, config } = args;
  const profileName =
    cliOptions.profile ?? config?.defaultProfile ?? inferSingleProfileName(config);
  const profile = profileName ? readProfile(config, profileName) : undefined;

  return {
    approvalPolicy:
      normalizeApprovalPolicy(cliOptions.approvalPolicy) ?? profile?.approvalPolicy ?? "prompt",
    baseUrl: cliOptions.baseUrl ?? profile?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    contextWindowTokens: profile?.contextWindowTokens,
    maxSteps: cliOptions.maxSteps ?? profile?.maxSteps,
    model: cliOptions.model ?? profile?.model,
    networkEgress: profile?.networkEgress,
    profileName,
    timeout: cliOptions.timeout ?? profile?.timeout
  };
}

export function parseTimeoutToMs(timeout: string | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }

  const match = timeout.trim().match(/^(\d+)(ms|s|m)?$/);
  if (!match) {
    throw new ConfigError(
      "`--timeout` must be a positive integer in milliseconds or use the suffixes ms, s, or m."
    );
  }

  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError("`--timeout` must be greater than 0.");
  }

  const unit = match[2] ?? "ms";
  return unit === "ms" ? value : unit === "s" ? value * 1_000 : value * 60_000;
}

export interface ResolvedLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function resolveLlmConfig(args: {
  config: CodingAgentConfig | null;
  executionConfig: ResolvedExecutionConfig;
}): ResolvedLlmConfig {
  const { executionConfig, config } = args;

  if (!executionConfig.model) {
    throw new ConfigError(
      "A model is required. Set it in `~/.coding-agent/config.json` or pass `--model`."
    );
  }

  const profile = executionConfig.profileName
    ? readProfile(config, executionConfig.profileName)
    : undefined;
  const apiKey = profile?.apiKey;

  if (!apiKey) {
    throw new ConfigError("An API key is required in `~/.coding-agent/config.json`.");
  }

  return {
    apiKey,
    baseUrl: executionConfig.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    model: executionConfig.model
  };
}

function inferSingleProfileName(
  config: CodingAgentConfig | null
): string | undefined {
  if (!config) {
    return undefined;
  }

  const names = Object.keys(config.profiles);
  return names.length === 1 ? names[0] : undefined;
}

function readProfile(
  config: CodingAgentConfig | null,
  profileName: string
): CodingAgentProfile {
  if (!config) {
    throw new ConfigError(`Profile \`${profileName}\` was requested but no config file was found.`);
  }

  const profile = config.profiles[profileName];

  if (!profile) {
    throw new ConfigError(`Profile \`${profileName}\` was not found in ${DEFAULT_CONFIG_FILE}.`);
  }

  return profile;
}

function normalizeConfigError(error: unknown, fileName: string): string {
  if (error instanceof Error && error.name === "ZodError") {
    return `Invalid config in ${fileName}.`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return `Failed to load ${fileName}.`;
}

function normalizeApprovalPolicy(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = approvalPolicySchema.safeParse(value);

  if (!parsed.success) {
    throw new ConfigError(
      "`--approval-policy` must be one of: auto, prompt, never."
    );
  }

  return parsed.data;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
