import { spawn } from "node:child_process";
import type { Observation, VerificationRun } from "../cli/output.js";

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
      env: process.env
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
