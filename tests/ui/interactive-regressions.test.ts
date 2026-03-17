import { afterEach, describe, expect, it } from "vitest";
import { cleanupFailureArtifacts, captureFailureArtifacts } from "../helpers/artifact-capture.js";
import {
  cleanupCliHarness,
  distCli,
  ensureBuiltCli,
  makeHomeDir,
  makeWorkspace,
  repoRoot
} from "../helpers/cli-harness.js";
import { cleanupMockLlmServers, createMockLlmServer, finalResponse, toolCallResponse } from "../helpers/mock-llm.js";
import {
  spawnInteractiveCli,
  typeText,
  waitForExit,
  waitForOutput,
  waitForOutputOrder
} from "../helpers/pty-harness.js";

describe("interactive regressions", () => {
  afterEach(async () => {
    await cleanupMockLlmServers();
    await cleanupCliHarness();
    await cleanupFailureArtifacts();
  });

  it(
    "acknowledges approval before running the approved command",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'hello\\n'; sleep 1; printf 'created' > created.txt"
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

        const ordering = await waitForOutputOrder(session, {
          first: "Approval approved.",
          second: "Running command.",
          timeoutMs: 3_000
        });

        if (ordering !== "first") {
          await captureFailureArtifacts({
            failure: {
              details: session.getOutput(),
              kind: "ui_feedback_gap"
            },
            summary: "approval acknowledgement must render before command execution",
            transcript: session.getOutput()
          });
        }

        expect(ordering).toBe("first");
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "drains a queued prompt after an approved command completes",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'shell-start\\n'; sleep 1; printf 'created' > created.txt"
        }),
        finalResponse("First task done."),
        finalResponse("Second task done.")
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

        await typeText(session.stdin, "How's it going?");
        session.stdin.write("\r");
        await waitForOutput(session, "Queued: How's it going?", 4_000);

        session.stdin.write("\r");
        await waitForOutput(session, "First task done.", 8_000);
        await waitForOutput(session, "Second task done.", 8_000);
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "labels one shell command as a single command even when output lines are present",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'shell-start\\n'; sleep 1; printf 'created' > created.txt"
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
        await waitForOutput(session, "Output: shell-start", 8_000);

        const output = session.getOutput();
        expect(output).toContain("Ran command");
        expect(output).not.toContain("Ran 2 commands");
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "does not duplicate the final assistant message in the transcript",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([finalResponse("Single final answer.")]);
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
        await typeText(session.stdin, "Just answer once");
        session.stdin.write("\r");
        await waitForOutput(session, "Single final answer.", 8_000);

        const count = session.getOutput().match(/Single final answer\./g)?.length ?? 0;
        expect(count).toBe(1);
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );
});
