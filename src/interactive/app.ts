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
  const terminal = process.stdout;
  let restoredScreen = false;

  if (!stdin.isTTY || typeof terminal.columns !== "number" || typeof terminal.rows !== "number") {
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

  const restoreScreen = () => {
    if (restoredScreen) {
      return;
    }
    restoredScreen = true;
    stdout.write("\x1b[?1049l");
  };

  stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
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
      incrementalRendering: false,
      maxFps: 20,
      patchConsole: false,
      stdin,
      stdout: terminal
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
      restoreScreen();
      stdout.write(`Last session: ${payload.sessionId} (${payload.status})\n`);
      return payload?.code ?? 0;
    }
    return payload?.code ?? 0;
  } finally {
    instance.cleanup();
    restoreScreen();
  }
}
