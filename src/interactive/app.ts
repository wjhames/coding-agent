import process from "node:process";
import React from "react";
import { render } from "ink";
import type { CliIO } from "../cli/output.js";
import type { ParsedOptions } from "../cli/parse.js";
import { listSessions, runDoctor, type RuntimeEnvironment } from "../runtime/api.js";
import { InteractiveApp } from "./ui.js";

export async function runInteractiveApp(args: {
  io?: CliIO;
  options: ParsedOptions;
  runtime?: RuntimeEnvironment;
}): Promise<number> {
  const stdin = process.stdin;
  const stdout = args.io?.stdout ?? process.stdout;

  if (!stdin.isTTY || typeof process.stdout.columns !== "number" || typeof process.stdout.rows !== "number") {
    stdout.write("Interactive mode requires a TTY.\n");
    return 1;
  }

  const doctor = await runDoctor({
    ...(args.runtime ? { environment: args.runtime } : {}),
    options: args.options
  }).catch(() => null);
  const recentSessions = await listSessions({
    ...(args.runtime ? { environment: args.runtime } : {}),
    limit: 5
  }).catch(() => []);

  const instance = render(
    React.createElement(InteractiveApp, {
      doctor,
      onExit: () => {},
      options: args.options,
      recentSessions,
      ...(args.runtime ? { runtime: args.runtime } : {})
    }),
    {
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 30,
      patchConsole: false,
      stdin,
      stdout: process.stdout
    }
  );

  try {
    const payload = (await instance.waitUntilExit()) as
      | {
          code: number;
          sessionId: string | null;
          status: string;
        }
      | undefined;
    if (payload?.sessionId) {
      stdout.write(`Last session: ${payload.sessionId} (${payload.status})\n`);
    }
    return payload?.code ?? 0;
  } finally {
    instance.cleanup();
  }
}
