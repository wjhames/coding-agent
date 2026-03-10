#!/usr/bin/env node

import process from "node:process";
import { renderExecHelp, renderResumeHelp, renderRootHelp } from "./help.js";
import {
  type CliIO,
  writeCommandError,
  writeCommandResult
} from "./output.js";
import { CliUsageError, parseCliArgs } from "./parse.js";

export async function runCli(
  argv: string[],
  io: CliIO = { stdout: process.stdout, stderr: process.stderr }
): Promise<number> {
  const wantsJson = argv.includes("--json");

  try {
    const invocation = parseCliArgs(argv);

    if (invocation.command === "interactive") {
      if (invocation.options.json) {
        await writeCommandError(
          io,
          {
            error: "json_not_supported",
            message: "`--json` is only supported for non-interactive commands.",
            exitCode: 1
          },
          true,
          invocation.options.output
        );

        return 1;
      }

      if (invocation.options.help) {
        io.stdout.write(`${renderRootHelp()}\n`);
        return 0;
      }

      io.stdout.write("Interactive mode is not implemented yet.\n");
      return 1;
    }

    if (invocation.options.help) {
      const helpText =
        invocation.command === "exec" ? renderExecHelp() : renderResumeHelp();
      io.stdout.write(`${helpText}\n`);
      return 0;
    }

    if (invocation.command === "exec") {
      await writeCommandError(
        io,
        {
          error: "not_implemented",
          message: "Non-interactive execution is not implemented yet.",
          exitCode: 1
        },
        invocation.options.json,
        invocation.options.output
      );

      return 1;
    }

    await writeCommandResult(
      io,
      {
        sessionId: invocation.sessionId ?? null,
        status: "failed",
        resumedFrom: invocation.sessionId ?? null,
        summary: "Resume is not implemented yet.",
        changedFiles: [],
        artifacts: [],
        verification: {
          commands: [],
          passed: false
        },
        approvals: [],
        exitCode: 1
      },
      invocation.options.json,
      invocation.options.output
    );

    return 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown CLI failure.";
    const normalizedError = {
      error: error instanceof CliUsageError ? "usage_error" : "cli_error",
      message,
      exitCode: 1 as const
    };

    await writeCommandError(io, normalizedError, wantsJson);
    return 1;
  }
}

const exitCode = await runCli(process.argv.slice(2));
process.exit(exitCode);
