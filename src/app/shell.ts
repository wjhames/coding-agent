import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Observation, VerificationRun } from "../runtime/contracts.js";
import { resolveWorkspacePath } from "../tools/workspace.js";

export interface ShellExecutionResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface ShellCommandSegment {
  arguments: string[];
  name: string | null;
  operatorBefore: string | null;
  tokens: string[];
}

export async function executeShellCommand(args: {
  command: string;
  cwd: string;
  timeoutMs?: number | undefined;
}): Promise<ShellExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", args.command], {
      cwd: args.cwd,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    const killTimer = args.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, args.timeoutMs)
      : null;
    const forceKillTimer = args.timeoutMs !== undefined
      ? setTimeout(() => {
          if (!timedOut || finished) {
            return;
          }

          child.kill("SIGKILL");
        }, args.timeoutMs + 1_000)
      : null;

    const clearTimers = () => {
      if (killTimer) {
        clearTimeout(killTimer);
      }

      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
    };

    const finishWithError = (error: Error) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimers();
      reject(error);
    };

    const finishWithResult = (result: ShellExecutionResult) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimers();
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finishWithError(error);
    });
    child.on("close", (code) => {
      if (timedOut) {
        finishWithError(
          new Error(`Shell command timed out after ${args.timeoutMs}ms: \`${args.command}\`.`)
        );
        return;
      }

      finishWithResult({
        exitCode: code ?? 1,
        stderr: truncate(stderr),
        stdout: truncate(stdout)
      });
    });
  });
}

export function shellResultToObservation(args: {
  command: string;
  result: ShellExecutionResult;
}): Observation {
  return {
    excerpt: [args.result.stdout, args.result.stderr].filter(Boolean).join("\n").trim(),
    query: args.command,
    summary: `Ran shell command: ${args.command}`,
    tool: "run_shell"
  };
}

export function assertShellWritesStayInWorkspace(args: {
  command: string;
  cwd: string;
}): void {
  const context = resolveShellExecutionContext(args);

  for (const target of findWriteTargets(context.segments)) {
    try {
      resolveWorkspacePath(args.cwd, resolve(context.effectiveCwd, target));
    } catch {
      throw new Error(`Shell command writes outside the workspace: \`${target}\`.`);
    }
  }
}

function resolveShellExecutionContext(args: {
  command: string;
  cwd: string;
}): {
  commandStartIndex: number;
  effectiveCwd: string;
  segments: ShellCommandSegment[];
  tokens: string[];
} {
  const tokens = tokenizeShellCommand(args.command);
  const commandStartIndex = findCommandStartIndex(tokens);
  let effectiveCwd = args.cwd;
  let index = 0;

  while (index < commandStartIndex) {
    while (index < tokens.length && isLeadingEnvironmentAssignment(tokens[index] ?? "")) {
      index += 1;
    }

    if (
      tokens[index] === "set" &&
      (tokens[index + 1]?.startsWith("-") ?? false) &&
      tokens[index + 2] === "&&"
    ) {
      index += 3;
      continue;
    }

    if (tokens[index] === "cd" && tokens[index + 1] && tokens[index + 2] === "&&") {
      const requestedDir = tokens[index + 1] ?? ".";

      try {
        effectiveCwd = resolveWorkspacePath(args.cwd, resolve(effectiveCwd, requestedDir));
      } catch {
        throw new Error(`Shell command changes directory outside the workspace: \`${requestedDir}\`.`);
      }

      index += 3;
      continue;
    }

    break;
  }

  return {
    commandStartIndex,
    effectiveCwd,
    segments: parseShellCommandSegmentsFromTokens(tokens, commandStartIndex),
    tokens
  };
}

function findWriteRedirectTargets(tokens: string[]): string[] {
  const targets: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";

    if (!WRITE_REDIRECTION_TOKENS.has(token)) {
      continue;
    }

    const target = tokens[index + 1];
    if (!target || isShellControlOperator(target) || target.startsWith("&")) {
      continue;
    }

    targets.push(target);
    index += 1;
  }

  return targets;
}

function findWriteTargets(segments: ShellCommandSegment[]): string[] {
  const redirectedTargets = segments.flatMap((segment) => findWriteRedirectTargets(segment.tokens));
  const explicitTargets = segments.flatMap((segment) => findExplicitWriteTargets(segment));

  return [...new Set([...redirectedTargets, ...explicitTargets])];
}

function findExplicitWriteTargets(segment: ShellCommandSegment): string[] {
  if (segment.name === null) {
    return [];
  }

  const args = segment.arguments.filter(
    (token) => token.length > 0 && !isShellControlOperator(token)
  );

  if (segment.name === "touch" || segment.name === "mkdir") {
    return args.filter((token) => !token.startsWith("-"));
  }

  if ((segment.name === "cp" || segment.name === "mv") && args.length > 0) {
    return [args[args.length - 1] ?? ""].filter(Boolean);
  }

  if (segment.name === "tee") {
    return args.filter((token) => !token.startsWith("-"));
  }

  return [];
}

export function normalizeShellCommand(command: string): string {
  const segments = parseShellCommandSegments(command);
  return segments
    .map((segment, index) => {
      const normalized = normalizeShellSegment(segment);
      if (normalized.length === 0) {
        return "";
      }

      return index === 0 ? normalized : `${segment.operatorBefore ?? ""} ${normalized}`.trim();
    })
    .filter((segment) => segment.length > 0)
    .join(" ")
    .trim()
    .toLowerCase();
}

export function parseShellCommandSegments(command: string): ShellCommandSegment[] {
  const tokens = tokenizeShellCommand(command);
  return parseShellCommandSegmentsFromTokens(tokens, findCommandStartIndex(tokens));
}

export function isReadOnlyShellSegment(segment: ShellCommandSegment): boolean {
  if (segment.name === null) {
    return false;
  }

  if (segment.name === "git") {
    return segment.arguments[0] === "status" || segment.arguments[0] === "diff";
  }

  if (segment.name === "sed") {
    return segment.arguments[0] === "-n";
  }

  return READ_ONLY_COMMANDS.has(segment.name);
}

export function normalizeShellSegmentForComparison(segment: ShellCommandSegment): string {
  return normalizeShellSegment(segment).toLowerCase();
}

function firstCommandToken(tokens: string[]): {
  arguments: string[];
  name: string;
} | null {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] ?? "";

    if (isShellControlOperator(token)) {
      break;
    }

    if (token.length === 0 || isLeadingEnvironmentAssignment(token)) {
      index += 1;
      continue;
    }

    return {
      arguments: tokens.slice(index + 1),
      name: token
    };
  }

  return null;
}

function parseShellCommandSegmentsFromTokens(
  tokens: string[],
  commandStartIndex: number
): ShellCommandSegment[] {
  const segments: ShellCommandSegment[] = [];
  let operatorBefore: string | null = null;
  let current: string[] = [];

  const pushSegment = () => {
    if (current.length === 0) {
      return;
    }

    const command = firstCommandToken(current);
    segments.push({
      arguments: command?.arguments ?? [],
      name: command?.name ?? null,
      operatorBefore,
      tokens: current
    });
    current = [];
  };

  for (const token of tokens.slice(commandStartIndex)) {
    if (isShellControlOperator(token)) {
      pushSegment();
      operatorBefore = token;
      continue;
    }

    current.push(token);
  }

  pushSegment();

  return segments;
}

function findCommandStartIndex(tokens: string[]): number {
  let index = 0;

  while (index < tokens.length) {
    while (index < tokens.length && isLeadingEnvironmentAssignment(tokens[index] ?? "")) {
      index += 1;
    }

    if (
      tokens[index] === "set" &&
      (tokens[index + 1]?.startsWith("-") ?? false) &&
      tokens[index + 2] === "&&"
    ) {
      index += 3;
      continue;
    }

    if (tokens[index] === "cd" && tokens[index + 1] && tokens[index + 2] === "&&") {
      index += 3;
      continue;
    }

    break;
  }

  return index;
}

function normalizeShellSegment(segment: ShellCommandSegment): string {
  if (segment.name === null) {
    return "";
  }

  const tokens = [segment.name, ...stripHarmlessComparisonTokens(segment.arguments)];
  return tokens.join(" ").trim();
}

function stripHarmlessComparisonTokens(tokens: string[]): string[] {
  const normalized: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1] ?? "";

    if ((token === "2>" || token === "2>>") && next === "&1") {
      index += 1;
      continue;
    }

    normalized.push(token);
  }

  return normalized;
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote !== "'"
      && char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if ((char === "&" || char === "|") && next === char) {
      pushCurrent();
      tokens.push(`${char}${char}`);
      index += 1;
      continue;
    }

    if (char === ";" || char === "|") {
      pushCurrent();
      tokens.push(char);
      continue;
    }

    if (char === ">") {
      const prefix = /^(?:\d+|&)$/.test(current) ? current : "";
      if (prefix.length > 0) {
        current = "";
      } else {
        pushCurrent();
      }

      const operator = next === ">" ? `${prefix}>>` : `${prefix}>`;
      tokens.push(operator);
      if (next === ">") {
        index += 1;
      }
      continue;
    }

    current += char;
  }

  pushCurrent();

  return tokens;
}

function isLeadingEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function isShellControlOperator(token: string): boolean {
  return token === "&&" || token === "||" || token === "|" || token === ";";
}

const WRITE_REDIRECTION_TOKENS = new Set([">", ">>", "1>", "1>>", "2>", "2>>", "&>", "&>>"]);
const READ_ONLY_COMMANDS = new Set(["pwd", "ls", "find", "rg", "cat", "head", "tail", "wc", "stat"]);

export function shellResultToVerificationRun(args: {
  command: string;
  result: ShellExecutionResult;
}): VerificationRun {
  return {
    command: args.command,
    exitCode: args.result.exitCode,
    passed: args.result.exitCode === 0,
    stderr: args.result.stderr,
    stdout: args.result.stdout
  };
}

function truncate(value: string): string {
  return value.slice(0, 16_000);
}
