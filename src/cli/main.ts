#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import process from "node:process";
import { ApprovalDeniedError } from "../app/approval.js";
import { ConfigError } from "../config/load.js";
import { LlmError } from "../llm/openai-client.js";
import { SessionStoreError } from "../session/store.js";
import { listSessions, resumeTask, runDoctor, startTask } from "../runtime/api.js";
import { runInteractiveApp } from "../interactive/app.js";
import {
  renderDoctorHelp,
  renderExecHelp,
  renderResumeHelp,
  renderRootHelp,
  renderSessionsHelp
} from "./help.js";
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

      return runInteractiveApp({
        io,
        options: invocation.options,
        runtime
      });
    }

    if (invocation.options.help) {
      const helpText =
        invocation.command === "exec"
          ? renderExecHelp()
          : invocation.command === "resume"
            ? renderResumeHelp()
            : invocation.command === "doctor"
              ? renderDoctorHelp()
              : invocation.command === "sessions"
                ? renderSessionsHelp()
                : renderRootHelp();
      io.stdout.write(`${helpText}\n`);
      return 0;
    }

    if (invocation.command === "doctor") {
      const doctor = await runDoctor({
        environment: runtime,
        options: invocation.options
      });
      const body = invocation.options.json
        ? `${JSON.stringify(doctor, null, 2)}\n`
        : `Config present: ${doctor.configPresent}\nLLM ready: ${doctor.llmReady}\nModel: ${doctor.model ?? "unset"}\nProfiles: ${doctor.profiles.join(", ") || "none"}\n`;
      io.stdout.write(body);
      return 0;
    }

    if (invocation.command === "sessions") {
      const sessions = await listSessions({
        environment: runtime
      });
      const body = invocation.options.json
        ? `${JSON.stringify(sessions, null, 2)}\n`
        : `${sessions.map((session) => `${session.id} ${session.status} ${session.updatedAt}`).join("\n")}\n`;
      io.stdout.write(body);
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

      const result = await startTask({
        environment: runtime,
        observer: undefined,
        options: invocation.options,
        prompt: invocation.prompt
      });

      await writeCommandResult(
        io,
        result,
        invocation.options.json,
        invocation.options.output
      );

      return result.exitCode;
    }

    const result = await resumeTask({
      environment: runtime,
      observer: undefined,
      options: invocation.options,
      ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {})
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
              : error instanceof ApprovalDeniedError
                ? "approval_required"
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
