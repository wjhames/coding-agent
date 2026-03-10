import { parseArgs } from "node:util";

export type CommandName = "interactive" | "exec" | "resume";

export interface ParsedOptions {
  approvalPolicy: string | undefined;
  baseUrl: string | undefined;
  cwd: string | undefined;
  help: boolean;
  json: boolean;
  maxSteps: number | undefined;
  model: string | undefined;
  output: string | undefined;
  profile: string | undefined;
  quiet: boolean;
  timeout: string | undefined;
  verbose: boolean;
}

export interface CliInvocation {
  command: CommandName;
  options: ParsedOptions;
  prompt: string | undefined;
  sessionId: string | undefined;
}

export class CliUsageError extends Error {}

const optionSpec = {
  "approval-policy": { type: "string" as const },
  "base-url": { type: "string" as const },
  cwd: { type: "string" as const, short: "C" },
  help: { type: "boolean" as const, short: "h" },
  json: { type: "boolean" as const },
  "max-steps": { type: "string" as const },
  model: { type: "string" as const },
  output: { type: "string" as const },
  profile: { type: "string" as const, short: "p" },
  quiet: { type: "boolean" as const },
  timeout: { type: "string" as const },
  verbose: { type: "boolean" as const }
};

export function parseCliArgs(argv: string[]): CliInvocation {
  const [first, ...rest] = argv;
  const command = first === "exec" || first === "resume" ? first : "interactive";
  const commandArgv = command === "interactive" ? argv : rest;
  const parsed = parseArgs({
    args: commandArgv,
    allowPositionals: true,
    options: optionSpec,
    strict: true
  });

  const options = normalizeOptions(parsed.values);

  if (command === "interactive") {
    return {
      command,
      options,
      prompt: undefined,
      sessionId: undefined
    };
  }

  if (command === "exec") {
    return {
      command,
      options,
      prompt: parsed.positionals.join(" ").trim() || undefined,
      sessionId: undefined
    };
  }

  if (parsed.positionals.length > 1) {
    throw new CliUsageError("`resume` accepts at most one session id.");
  }

  return {
    command,
    options,
    prompt: undefined,
    sessionId: parsed.positionals[0]
  };
}

function normalizeOptions(
  values: Record<string, unknown>
): ParsedOptions {
  const maxStepsValue = values["max-steps"];

  return {
    approvalPolicy: asOptionalString(values["approval-policy"]),
    baseUrl: asOptionalString(values["base-url"]),
    cwd: asOptionalString(values.cwd),
    help: Boolean(values.help),
    json: Boolean(values.json),
    maxSteps: parseOptionalInteger(maxStepsValue),
    model: asOptionalString(values.model),
    output: asOptionalString(values.output),
    profile: asOptionalString(values.profile),
    quiet: Boolean(values.quiet),
    timeout: asOptionalString(values.timeout),
    verbose: Boolean(values.verbose)
  };
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError("`--max-steps` must be a positive integer.");
  }

  return parsed;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return value;
}
