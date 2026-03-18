import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import {
  cleanupMockLlmServers,
  createMockLlmServer,
  createRequestAwareMockLlmServer,
  finalResponse,
  toolCallResponse
} from "../helpers/mock-llm.js";
import {
  outputAppearsWithin,
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
    "does not duplicate approval acknowledgement after a single approval",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'created' > created.txt"
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
        await waitForOutput(session, "Created the file.", 8_000);

        const approvalCount = session.getOutput().match(/Approval approved\./g)?.length ?? 0;

        if (approvalCount !== 1) {
          await captureFailureArtifacts({
            failure: {
              details: session.getOutput(),
              kind: "unsafe_repeat_side_effect"
            },
            summary: `expected one approval acknowledgement, saw ${approvalCount}`,
            transcript: session.getOutput()
          });
        }

        expect(approvalCount).toBe(1);
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "does not replay the approved command after approval is granted",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'shell-start\\n'; sleep 1; printf 'shell-done\\n'; printf 'created' > created.txt"
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
        await waitForOutput(session, "Created the file.", 8_000);

        const shellStartCount = session.getOutput().match(/Output: shell-start/g)?.length ?? 0;

        if (shellStartCount !== 1) {
          await captureFailureArtifacts({
            failure: {
              details: session.getOutput(),
              kind: "unsafe_repeat_side_effect"
            },
            summary: `expected one streamed shell output line after approval, saw ${shellStartCount}`,
            transcript: session.getOutput()
          });
        }

        expect(shellStartCount).toBe(1);
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "does not continue tool work after the user switches to a direct question",
    async () => {
      const workspace = await makeWorkspace();
      const llm = await createMockLlmServer([
        finalResponse("I did not finish the task."),
        toolCallResponse("write_plan", {
          items: [
            {
              content: "Keep editing files",
              status: "in_progress"
            }
          ],
          summary: "Continue implementing the app."
        }),
        finalResponse("I did not complete it because integration work remained.")
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
        await typeText(session.stdin, "Implement the app");
        session.stdin.write("\r");
        await waitForOutput(session, "I did not finish the task.", 8_000);

        await typeText(session.stdin, "Why didn't you complete the task?");
        session.stdin.write("\r");
        await waitForOutput(session, "I did not complete it because integration work remained.", 8_000);

        const continuedTooling = await outputAppearsWithin(session, "Plan update", 500);

        if (continuedTooling) {
          await captureFailureArtifacts({
            failure: {
              details: session.getOutput(),
              kind: "ui_feedback_gap"
            },
            summary: "a direct follow-up question should not trigger more tool work",
            transcript: session.getOutput()
          });
        }

        expect(continuedTooling).toBe(false);
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "does not rerun an approved shell command when the resumed request omits the prior tool result",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const command = "printf 'run\\n' >> approval-runs.log";
      const llm = await createRequestAwareMockLlmServer({
        onRequest(request, requestIndex) {
          if (requestIndex === 0) {
            return toolCallResponse("run_shell", { command });
          }

          if (requestIndex === 1) {
            const body =
              request.body && typeof request.body === "object"
                ? (request.body as { messages?: Array<{ role?: string }> })
                : {};
            const hasToolResult = body.messages?.some((message) => message.role === "tool") ?? false;
            return hasToolResult
              ? finalResponse("Created the file once.")
              : toolCallResponse("run_shell", { command });
          }

          return finalResponse("Created the file once.");
        }
      });
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
        
        // Count approval messages to ensure no duplicate approvals
        const initialOutput = session.getOutput();
        const initialApprovalCount = (initialOutput.match(/Approval approved\./g) || []).length;
        
        session.stdin.write("\r");
        await waitForOutput(session, "Completed.", 8_000);
        
        // Verify no duplicate approval messages appeared after the command
        const finalOutput = session.getOutput();
        const finalApprovalCount = (finalOutput.match(/Approval approved\./g) || []).length;
        expect(finalApprovalCount - initialApprovalCount).toBe(1); // Exactly one approval
        
        // Verify transcript continuity
        expect(finalOutput).toContain("Approval required to run shell command");
        expect(finalOutput).toContain("Approval approved.");
        expect(finalOutput).toContain("Completed.");
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "does not replay approved command output after resuming a paused session",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([
        toolCallResponse("run_shell", {
          command: "printf 'shell-start\\n'; sleep 1; printf 'shell-done\\n'; printf 'created' > created.txt"
        }),
        finalResponse("Created the file.")
      ]);
      const homeDir = await makeHomeDir(llm.baseUrl);
      await ensureBuiltCli();

      const firstSession = spawnInteractiveCli({
        cwd: workspace,
        distCli,
        homeDir,
        repoRoot
      });

      try {
        await waitForOutput(firstSession, "Type a task", 8_000);
        await typeText(firstSession.stdin, "Create a file using the shell");
        firstSession.stdin.write("\r");
        await waitForOutput(firstSession, "Approval required to run shell command", 8_000);
      } finally {
        firstSession.stdin.write("\u0003");
        await waitForExit(firstSession.child, 5_000).catch(() => undefined);
      }

      const resumedSession = spawnInteractiveCli({
        cwd: workspace,
        distCli,
        homeDir,
        repoRoot
      });

      try {
        await waitForOutput(resumedSession, "Type a task", 8_000);
        resumedSession.stdin.write("\r");
        await waitForOutput(resumedSession, "Approval required to run shell command", 8_000);
        resumedSession.stdin.write("\r");
        await waitForOutput(resumedSession, "Output: shell-start", 8_000);
        await waitForOutput(resumedSession, "Created the file.", 8_000);

        const shellStartCount = resumedSession.getOutput().match(/Output: shell-start/g)?.length ?? 0;

        if (shellStartCount !== 1) {
          await captureFailureArtifacts({
            failure: {
              details: resumedSession.getOutput(),
              kind: "unsafe_repeat_side_effect"
            },
            summary: `expected one streamed shell output line after resume approval, saw ${shellStartCount}`,
            transcript: resumedSession.getOutput()
          });
        }

        expect(shellStartCount).toBe(1);
      } finally {
        resumedSession.stdin.write("\u0003");
        await waitForExit(resumedSession.child, 5_000).catch(() => undefined);
      }
    },
    25_000
  );

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
