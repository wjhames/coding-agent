#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import process from "node:process";
import { runExec } from "../app/exec.js";
import { runResume } from "../app/resume.js";
import { ConfigError } from "../config/load.js";
import { LlmError } from "../llm/openai.js";
import { SessionStoreError } from "../session/store.js";
import { renderExecHelp, renderResumeHelp, renderRootHelp } from "./help.js";
import {
  type CliIO,
  writeCommandError,
  writeCommandResult
} from "./output.js";
import { CliUsageError, parseCliArgs } from "./parse.js";

export async function runCli(
  argv: string[],
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
  runtime: {
    fetchImpl?: typeof fetch;
    processCwd?: string;
    sessionHomeDir?: string;
  } = {}
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
      if (!invocation.prompt) {
        await writeCommandError(
          io,
          {
            error: "usage_error",
            message: "`coding-agent exec` requires a prompt.",
            exitCode: 1
          },
          invocation.options.json,
          invocation.options.output
        );

        return 1;
      }

      const result = await runExec({
        fetchImpl: runtime.fetchImpl,
        options: invocation.options,
        processCwd: runtime.processCwd,
        prompt: invocation.prompt,
        sessionHomeDir: runtime.sessionHomeDir
      });

      await writeCommandResult(
        io,
        result,
        invocation.options.json,
        invocation.options.output
      );

      return result.exitCode;
    }

    const result = await runResume({
      fetchImpl: runtime.fetchImpl,
      options: invocation.options,
      sessionHomeDir: runtime.sessionHomeDir,
      sessionId: invocation.sessionId
    });

    if (!result) {
      await writeCommandError(
        io,
        {
          error: "session_not_found",
          message: invocation.sessionId
            ? `Session \`${invocation.sessionId}\` was not found.`
            : "No saved sessions were found.",
          exitCode: 1
        },
        invocation.options.json,
        invocation.options.output
      );

      return 1;
    }

    await writeCommandResult(io, result, invocation.options.json, invocation.options.output);

    return result.exitCode;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown CLI failure.";
    const normalizedError = {
      error:
        error instanceof CliUsageError
          ? "usage_error"
          : error instanceof ConfigError
            ? "config_error"
            : error instanceof LlmError
              ? "llm_error"
              : error instanceof TypeError
                ? "network_error"
            : error instanceof SessionStoreError
              ? "session_error"
              : "cli_error",
      message,
      exitCode: 1 as const
    };

    await writeCommandError(io, normalizedError, wantsJson);
    return 1;
  }
}

if (isEntrypoint()) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];

  if (!entry) {
    return false;
  }

  return import.meta.url === pathToFileURL(entry).href;
}
