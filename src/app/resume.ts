import type { CommandResult, RuntimeObserver } from "../cli/output.js";
import { continueExec } from "./exec.js";
import { resultFromSession } from "./result.js";
import { listRecentSessions, loadSession } from "../session/store.js";
import type { ParsedOptions } from "../cli/parse.js";

export async function runResume(args: {
  fetchImpl: typeof fetch | undefined;
  observer: RuntimeObserver | undefined;
  options: ParsedOptions;
  sessionHomeDir: string | undefined;
  sessionId: string | undefined;
}): Promise<CommandResult | null> {
  const session = args.sessionId
    ? await loadSession(args.sessionId, args.sessionHomeDir)
    : (await listRecentSessions(1, args.sessionHomeDir))[0] ?? null;

  if (!session) {
    return null;
  }

  if (session.status !== "paused") {
    return {
      ...resultFromSession(session),
      resumedFrom: session.id
    };
  }

  const result = await continueExec({
    fetchImpl: args.fetchImpl,
    observer: args.observer,
    options: args.options,
    session,
    sessionHomeDir: args.sessionHomeDir
  });

  return {
    ...result,
    resumedFrom: session.id
  };
}
