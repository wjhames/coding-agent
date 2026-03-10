import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedOptions } from "../cli/parse.js";
import {
  approvalPolicySchema,
  configSchema,
  type CodingAgentConfig,
  type CodingAgentProfile
} from "./schema.js";

export const DEFAULT_CONFIG_FILE = ".coding-agent.json";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

export interface ResolvedExecutionConfig {
  apiKeyEnv: string | undefined;
  approvalPolicy: CodingAgentProfile["approvalPolicy"];
  baseUrl: string | undefined;
  maxSteps: number | undefined;
  model: string | undefined;
  networkEgress: boolean | undefined;
  profileName: string | undefined;
  timeout: string | undefined;
}

export class ConfigError extends Error {}

export async function loadConfig(
  cwd: string,
  fileName = DEFAULT_CONFIG_FILE
): Promise<CodingAgentConfig | null> {
  const path = join(cwd, fileName);

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
  const profileName = cliOptions.profile ?? config?.defaultProfile;
  const profile = profileName ? readProfile(config, profileName) : undefined;

  return {
    apiKeyEnv: profile?.apiKeyEnv ?? DEFAULT_OPENAI_API_KEY_ENV,
    approvalPolicy:
      normalizeApprovalPolicy(cliOptions.approvalPolicy) ?? profile?.approvalPolicy,
    baseUrl: cliOptions.baseUrl ?? profile?.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    maxSteps: cliOptions.maxSteps ?? profile?.maxSteps,
    model: cliOptions.model ?? profile?.model,
    networkEgress: profile?.networkEgress,
    profileName,
    timeout: cliOptions.timeout ?? profile?.timeout
  };
}

export interface ResolvedLlmConfig {
  apiKey: string;
  apiKeyEnv: string;
  baseUrl: string;
  model: string;
}

export function resolveLlmConfig(args: {
  executionConfig: ResolvedExecutionConfig;
  env: NodeJS.ProcessEnv;
}): ResolvedLlmConfig {
  const { executionConfig, env } = args;

  if (!executionConfig.model) {
    throw new ConfigError("A model is required. Set it in `.coding-agent.json` or pass `--model`.");
  }

  const apiKeyEnv = executionConfig.apiKeyEnv ?? DEFAULT_OPENAI_API_KEY_ENV;
  const apiKey = env[apiKeyEnv];

  if (!apiKey) {
    throw new ConfigError(
      `API key env \`${apiKeyEnv}\` is not set.`
    );
  }

  return {
    apiKey,
    apiKeyEnv,
    baseUrl: executionConfig.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    model: executionConfig.model
  };
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
