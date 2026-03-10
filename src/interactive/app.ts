import process from "node:process";
import readline from "node:readline";
import { approveTask, listSessions, resumeTask, runDoctor, startTask } from "../runtime/api.js";
import type { RuntimeDoctor, RuntimeEnvironment } from "../runtime/api.js";
import type { CliIO, RuntimeEvent } from "../cli/output.js";
import type { ParsedOptions } from "../cli/parse.js";
import type { SessionRecord } from "../session/store.js";
import { applyCommandResult, applyRuntimeEvent, createInitialInteractiveState } from "./state.js";
import type { InteractiveState } from "./state.js";
import { renderInteractiveScreen } from "./render.js";

export async function runInteractiveApp(args: {
  io?: CliIO;
  options: ParsedOptions;
  runtime?: RuntimeEnvironment;
}): Promise<number> {
  const stdin = process.stdin;
  const stdout = args.io?.stdout ?? process.stdout;
  const terminal = stdout as typeof process.stdout;

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
  let state = createInitialInteractiveState({
    cwd: args.runtime?.processCwd ?? process.cwd(),
    doctor,
    recentSessions
  });

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?1049h\x1b[?25l");

  const render = () => {
    stdout.write("\x1b[2J\x1b[H");
    stdout.write(
      renderInteractiveScreen({
        columns: terminal.columns,
        rows: terminal.rows,
        state
      })
    );
  };

  const applyEvent = (event: RuntimeEvent) => {
    state = applyRuntimeEvent(state, event);
    render();
  };

  const refreshRecentSessions = async () => {
    state = {
      ...state,
      recentSessions: await listSessions({
        ...(args.runtime ? { environment: args.runtime } : {}),
        limit: 5
      }).catch(() => state.recentSessions)
    };
  };

  const handleResult = async (result: Awaited<ReturnType<typeof startTask>> | Awaited<ReturnType<typeof resumeTask>>) => {
    if (!result) {
      state = {
        ...state,
        currentRun: null,
        footerMessage: "Session not found."
      };
      render();
      return;
    }

    state = applyCommandResult(state, result);
    render();
    await refreshRecentSessions();
    render();
  };

  const startRun = async (mode: "approve" | "resume" | "start") => {
    if (state.currentRun) {
      return;
    }

    const prompt = state.input.trim();
    const selectedSession = state.recentSessions[state.selectedSessionIndex] ?? null;
    const observer = {
      onEvent(event: RuntimeEvent) {
        applyEvent(event);
      }
    };

    if (mode === "start" && prompt.length === 0) {
      return;
    }

    if (mode !== "start" && !selectedSession) {
      return;
    }

    if (mode === "start") {
      state = {
        ...state,
        artifacts: [],
        changedFiles: [],
        footerMessage: "Running task...",
        input: "",
        mode: "running",
        pendingApproval: null,
        plan: null,
        runtimeStatus: "planning",
        sessionId: null,
        selectedTranscriptIndex: state.transcript.length,
        transcript: [
          ...state.transcript,
          {
            body: prompt,
            id: `user:${Date.now()}`,
            kind: "user",
            title: "You"
          }
        ],
        transcriptScroll: 0,
        verification: null
      };
      render();
      const run = startTask({
        ...(args.runtime ? { environment: args.runtime } : {}),
        observer,
        options: args.options,
        prompt
      })
        .then(handleResult)
        .finally(() => {
          state = {
            ...state,
            currentRun: null
          };
          render();
        });
      state = {
        ...state,
        currentRun: run
      };
      return;
    }

    if (!selectedSession) {
      return;
    }

    state = {
      ...state,
        footerMessage: mode === "approve" ? "Applying approval..." : `Resuming latest session...`,
        mode: "running",
        runtimeStatus: mode === "approve" ? "resuming" : "resuming",
        sessionId: selectedSession.id,
        transcript:
          mode === "resume"
          ? [
              ...state.transcript,
              {
                body: `Resuming ${selectedSession.id.slice(0, 8)}...`,
                detail: selectedSession.summary,
                id: `resume:${Date.now()}`,
                kind: "system",
                title: "Resume"
              }
            ]
          : state.transcript
    };
    render();

    const run =
      mode === "approve"
        ? approveTask({
            decision: state.approvalChoiceIndex === 0 ? "approve" : "reject",
            ...(args.runtime ? { environment: args.runtime } : {}),
            observer,
            options: args.options,
            sessionId: state.sessionId ?? selectedSession.id
          })
        : resumeTask({
            ...(args.runtime ? { environment: args.runtime } : {}),
            observer,
            options: args.options,
            sessionId: selectedSession.id
          });

    state = {
      ...state,
      currentRun: run.then(() => undefined)
    };
    render();

    run
      .then(handleResult)
      .finally(() => {
        state = {
          ...state,
          currentRun: null
        };
        render();
      });
  };

  let resolveExit: ((code: number) => void) | null = null;
  let cleanedUp = false;

  const onKeypress = async (_input: string | undefined, key: readline.Key) => {
    if (key.ctrl && key.name === "c") {
      cleanup();
      resolveExit?.(0);
      return;
    }

    if (state.mode === "running") {
      return;
    }

    if (state.mode === "details") {
      if (key.name === "escape" || key.name === "d") {
        state = {
          ...state,
          detailScroll: 0,
          mode: state.pendingApproval ? "approval" : "home"
        };
      } else if (key.name === "up") {
        state = {
          ...state,
          detailScroll: Math.max(0, state.detailScroll - 1)
        };
      } else if (key.name === "down") {
        state = {
          ...state,
          detailScroll: state.detailScroll + 1
        };
      }
      render();
      return;
    }

    if (state.mode === "approval") {
      if (key.name === "up" || key.name === "down") {
        state = {
          ...state,
          approvalChoiceIndex: state.approvalChoiceIndex === 0 ? 1 : 0
        };
      } else if (key.name === "return") {
        await startRun("approve");
        return;
      } else if (key.name === "d") {
        state = {
          ...state,
          mode: "details"
        };
      }
      render();
      return;
    }

    const isPrintableInput =
      typeof _input === "string" &&
      _input.length === 1 &&
      !_input.startsWith("\u001b") &&
      !key.ctrl &&
      !key.meta &&
      key.name !== "return" &&
      key.name !== "backspace" &&
      key.name !== "escape" &&
      key.name !== "tab" &&
      key.name !== "up" &&
      key.name !== "down";

    if (isPrintableInput) {
      state = {
        ...state,
        input: `${state.input}${_input}`
      };
      render();
      return;
    }

    if (key.name === "d") {
      state = {
        ...state,
        mode: "details"
      };
      render();
      return;
    }

    if (key.name === "up" || key.name === "down") {
      state = {
        ...state,
        selectedTranscriptIndex: clamp(
          state.selectedTranscriptIndex + (key.name === "up" ? -1 : 1),
          0,
          Math.max(0, state.transcript.length - 1)
        ),
        transcriptScroll: clamp(state.transcriptScroll + (key.name === "up" ? 1 : -1), 0, 10_000)
      };
      render();
      return;
    }

    if (key.name === "return") {
      if (state.input.trim().length > 0) {
        await startRun("start");
        return;
      }

      if (state.input.trim().length === 0 && state.recentSessions.length > 0) {
        await startRun("resume");
        return;
      }
      return;
    }

    if (key.name === "backspace") {
      state = {
        ...state,
        input: state.input.slice(0, -1)
      };
      render();
      return;
    }

    if (key.name === "escape") {
      state = {
        ...state,
        detailScroll: 0,
        footerMessage: null,
        input: ""
      };
      render();
      return;
    }

  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    stdin.off("keypress", onKeypress);
    stdin.setRawMode(false);
    stdout.write("\x1b[?25h\x1b[?1049l");
    if (state.sessionId) {
      stdout.write(`Last session: ${state.sessionId} (${state.runtimeStatus})\n`);
    }
  };

  stdin.on("keypress", onKeypress);
  render();

  return await new Promise<number>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
