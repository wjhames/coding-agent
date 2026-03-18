import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Observation, VerificationRun } from "../runtime/contracts.js";
import { resolveWorkspacePath } from "../tools/workspace.js";

export interface ShellExecutionResult {
  exitCode: number;
  stderr: string;
  stdout: string;
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
    const timer =
      args.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill("SIGTERM");
          }, args.timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }

      resolve({
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

  for (const target of findWriteTargets(context.tokens.slice(context.commandStartIndex))) {
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
  tokens: string[];
} {
  const tokens = tokenizeShellCommand(args.command);
  let effectiveCwd = args.cwd;
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
    commandStartIndex: index,
    effectiveCwd,
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

function findWriteTargets(tokens: string[]): string[] {
  const redirectedTargets = findWriteRedirectTargets(tokens);
  const explicitTargets = findExplicitWriteTargets(tokens);

  return [...new Set([...redirectedTargets, ...explicitTargets])];
}

function findExplicitWriteTargets(tokens: string[]): string[] {
  const command = firstCommandToken(tokens);

  if (command === null) {
    return [];
  }

  const args = command.arguments.filter(
    (token) => token.length > 0 && !isShellControlOperator(token)
  );

  if (command.name === "touch" || command.name === "mkdir") {
    return args.filter((token) => !token.startsWith("-"));
  }

  if ((command.name === "cp" || command.name === "mv") && args.length > 0) {
    return [args[args.length - 1] ?? ""].filter(Boolean);
  }

  if (command.name === "tee") {
    return args.filter((token) => !token.startsWith("-"));
  }

  return [];
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
