import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureFailureArtifacts, cleanupFailureArtifacts } from "../helpers/artifact-capture.js";
import {
  cleanupCliHarness,
  distCli,
  ensureBuiltCli,
  makeHomeDir,
  makeWorkspace,
  repoRoot,
  runBuiltCli
} from "../helpers/cli-harness.js";
import { createMockLlmServer, finalResponse, toolCallResponse, cleanupMockLlmServers } from "../helpers/mock-llm.js";
import {
  outputAppearsWithin,
  spawnInteractiveCli,
  typeText,
  waitForExit,
  waitForOutput,
  waitForOutputOrder
} from "../helpers/pty-harness.js";

describe("black-box cli workflows", () => {
  afterEach(async () => {
    await cleanupMockLlmServers();
    await cleanupCliHarness();
    await cleanupFailureArtifacts();
  });

  it(
    "executes a paused shell approval flow through the built CLI",
    async () => {
      const workspace = await makeWorkspace();
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'created' > created.txt"
        }),
        finalResponse("Created the file.")
      ]);
      const homeDir = await makeHomeDir(llm.baseUrl);

      const paused = await runBuiltCli(
        [
          "exec",
          "Create a file using the shell",
          "--json",
          "--cwd",
          workspace,
          "--approval-policy",
          "prompt"
        ],
        homeDir
      );

      expect(paused.exitCode).toBe(2);
      const pausedPayload = JSON.parse(paused.stdout);
      expect(pausedPayload.status).toBe("paused");

      const resumed = await runBuiltCli(
        [
          "resume",
          pausedPayload.sessionId,
          "--json",
          "--approval-policy",
          "auto"
        ],
        homeDir
      );

      expect(resumed.exitCode).toBe(0);
      const resumedPayload = JSON.parse(resumed.stdout);
      expect(resumedPayload.status).toBe("completed");
      expect(resumedPayload.changedFiles).toContain("created.txt");
      await expect(readFile(join(workspace, "created.txt"), "utf8")).resolves.toBe("created");
    },
    20_000
  );

  it(
    "streams approved shell command output into the interactive transcript before the command completes",
    async () => {
      const workspace = await makeWorkspace();
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'shell-start\\n'; sleep 2; printf 'shell-done\\n'; printf 'created' > created.txt"
        }),
        finalResponse("Created the file.")
      ]);
      const homeDir = await makeHomeDir(llm.baseUrl);
      await ensureBuiltCli();
      const session = spawnInteractiveCli({
        cwd: workspace,
        distCli,
        homeDir,
        repoRoot
      });

      try {
        await waitForOutput(session, "Type a task", 8_000);
        await typeText(session.stdin, "Create a file using the shell");
        session.stdin.write("\r");

        await waitForOutput(session, "Approval required to run shell command", 8_000);
        session.stdin.write("\r");

        await waitForOutput(session, "Approval approved.", 8_000);
        await waitForOutput(session, "Running command.", 8_000);

        const ordering = await waitForOutputOrder(session, {
          first: "Output: shell-start",
          second: "Completed.",
          timeoutMs: 2_500
        });
        expect(ordering).toBe("first");
      } catch (error) {
        await captureFailureArtifacts({
          failure: {
            details: error instanceof Error ? error.message : String(error),
            kind: "ui_feedback_gap"
          },
          summary: "interactive approval should acknowledge approval and stream live output",
          transcript: session.getOutput()
        });
        throw error;
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "shows shell command output in the interactive transcript while the approved command is still running",
    async () => {
      const workspace = await makeWorkspace();
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'shell-start\\n'; sleep 2; printf 'shell-done\\n'; printf 'created' > created.txt"
        }),
        finalResponse("Created the file.")
      ]);
      const homeDir = await makeHomeDir(llm.baseUrl);
      await ensureBuiltCli();
      const session = spawnInteractiveCli({
        cwd: workspace,
        distCli,
        homeDir,
        repoRoot
      });

      try {
        await waitForOutput(session, "Type a task", 8_000);
        await typeText(session.stdin, "Create a file using the shell");
        session.stdin.write("\r");

        await waitForOutput(session, "Approval required to run shell command", 8_000);
        session.stdin.write("\r");

        await waitForOutput(session, "Running command.", 8_000);

        const sawLiveOutput = await outputAppearsWithin(session, "shell-start", 900);
        expect(sawLiveOutput).toBe(true);
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );
});
