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
    "does not rerun an approved shell command after resume when the resumed request omits the prior tool result",
    async () => {
      const workspace = await makeWorkspace();
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
      await expect(readFile(join(workspace, "approval-runs.log"), "utf8")).resolves.toBe("run\n");
    },
    20_000
  );

  it(
    "replays prior tool exchanges with assistant tool_calls and matching tool_call_id on resume",
    async () => {
      const workspace = await makeWorkspace();
      const command = "printf 'run\\n' >> approval-runs.log";
      const llm = await createRequestAwareMockLlmServer({
        onRequest(request, requestIndex) {
          if (requestIndex === 0) {
            return toolCallResponse("run_shell", { command });
          }

          if (requestIndex === 1) {
            const body =
              request.body && typeof request.body === "object"
                ? (request.body as {
                    messages?: Array<{
                      content?: string;
                      role?: string;
                      tool_call_id?: string;
                      tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
                    }>;
                  })
                : {};
            const messages = body.messages ?? [];
            const assistantToolCall = messages.find(
              (message) =>
                message.role === "assistant" &&
                message.tool_calls?.some((toolCall) => toolCall.function?.name === "run_shell")
            );
            const toolMessage = messages.find((message) => message.role === "tool");
            const matchingToolCallId =
              toolMessage?.tool_call_id &&
              assistantToolCall?.tool_calls?.some((toolCall) => toolCall.id === toolMessage.tool_call_id);

            if (!assistantToolCall || !toolMessage || !matchingToolCallId) {
              return {
                status: 400,
                body: {
                  error: {
                    message:
                      "messages with role \"tool\" must be a response to a preceeding message with \"tool_calls\"."
                  }
                }
              };
            }

            return finalResponse("Created the file once.");
          }

          return finalResponse("Created the file once.");
        }
      });
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
      await expect(readFile(join(workspace, "approval-runs.log"), "utf8")).resolves.toBe("run\n");
    },
    20_000
  );

  it(
    "refreshes the active plan step in the next provider request after write_plan",
    async () => {
      const workspace = await makeWorkspace();
      const llm = await createRequestAwareMockLlmServer({
        onRequest(request, requestIndex) {
          if (requestIndex === 0) {
            return toolCallResponse("write_plan", {
              items: [
                {
                  content: "Create dashboard package",
                  status: "completed"
                },
                {
                  content: "Create App.jsx",
                  status: "pending"
                }
              ],
              summary: "Build the dashboard."
            });
          }

          return finalResponse("Dashboard planning is still in progress.");
        }
      });
      const homeDir = await makeHomeDir(llm.baseUrl, "auto");

      const run = await runBuiltCli(
        ["exec", "Build a dashboard with package.json and App.jsx", "--json", "--cwd", workspace],
        homeDir
      );

      expect(run.exitCode).toBe(1);
      const secondRequest =
        llm.requests[1]?.body && typeof llm.requests[1].body === "object"
          ? (llm.requests[1].body as { messages?: Array<{ content?: string; role?: string }> })
          : null;
      const systemMessage =
        secondRequest?.messages?.find((message) => message.role === "system")?.content ?? "";

      if (
        !systemMessage.includes("Plan: Build the dashboard.") ||
        !systemMessage.includes("Current next action: Create App.jsx")
      ) {
        await captureFailureArtifacts({
          failure: {
            details: systemMessage,
            kind: "completion_false_positive"
          },
          summary: "expected updated plan state in the next provider request"
        });
      }

      expect(systemMessage).toContain("Plan: Build the dashboard.");
      expect(systemMessage).toContain("Current next action: Create App.jsx");
    },
    20_000
  );

  it(
    "keeps replay history pair-aligned when approval resume follows multiple prior tool exchanges",
    async () => {
      const workspace = await makeWorkspace();
      const command = "printf 'run\\n' >> approval-runs.log";
      const llm = await createRequestAwareMockLlmServer({
        onRequest(request, requestIndex) {
          if (requestIndex === 0) {
            return toolCallResponse("write_plan", {
              summary: "First plan",
              items: [
                {
                  content: "Inspect requirements",
                  status: "in_progress"
                }
              ]
            });
          }

          if (requestIndex === 1) {
            return toolCallResponse("write_plan", {
              summary: "Second plan",
              items: [
                {
                  content: "Draft implementation",
                  status: "completed"
                }
              ]
            });
          }

          if (requestIndex === 2) {
            return toolCallResponse("run_shell", { command });
          }

          if (requestIndex === 3) {
            const body =
              request.body && typeof request.body === "object"
                ? (request.body as {
                    messages?: Array<{
                      content?: string;
                      role?: string;
                      tool_call_id?: string;
                      tool_calls?: Array<{ id?: string }>;
                    }>;
                  })
                : {};
            const messages = (body.messages ?? []).filter((message) => message.role !== "system");
            const firstReplayMessage = messages[0];
            const hasLeadingOrphanTool = firstReplayMessage?.role === "tool";
            const hasBrokenPairing = messages.some((message, index) => {
              if (message.role !== "tool" || !message.tool_call_id) {
                return false;
              }

              const previousMessage = messages[index - 1];
              return (
                previousMessage?.role !== "assistant" ||
                !previousMessage.tool_calls?.some((toolCall) => toolCall.id === message.tool_call_id)
              );
            });

            if (hasLeadingOrphanTool || hasBrokenPairing) {
              return {
                status: 400,
                body: {
                  error: {
                    message:
                      "messages with role \"tool\" must be a response to a preceeding message with \"tool_calls\"."
                  }
                }
              };
            }

            return finalResponse("Created the file once.");
          }

          return finalResponse("Created the file once.");
        }
      });
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
      await expect(readFile(join(workspace, "approval-runs.log"), "utf8")).resolves.toBe("run\n");
    },
    20_000
  );

  it(
    "surfaces provider 400 details in json cli errors",
    async () => {
      const workspace = await makeWorkspace();
      const llm = await createMockLlmServer([
        {
          status: 400,
          body: {
            error: {
              message:
                "messages with role \"tool\" must be a response to a preceeding message with \"tool_calls\"."
            }
          }
        }
      ]);
      const homeDir = await makeHomeDir(llm.baseUrl, "auto");

      const run = await runBuiltCli(
        ["exec", "Inspect the repo", "--json", "--cwd", workspace, "--max-steps", "1"],
        homeDir
      );

      expect(run.exitCode).toBe(1);
      const payload = JSON.parse(run.stdout || run.stderr) as {
        error?: string;
        message?: string;
        summary?: string;
      };
      const text = payload.message ?? payload.summary ?? "";
      expect(text).toContain("status 400");
      expect(text).toContain("messages with role \"tool\"");
    },
    20_000
  );

  it(
    "does not run verification for read-only inspection when the summary merely mentions build and tests",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          build: "node -e \"process.exit(0)\"",
          test: "node -e \"process.exit(0)\"",
          typecheck: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([
        finalResponse("This repository has build and test scripts and multiple tests under tests/ui.")
      ]);
      const homeDir = await makeHomeDir(llm.baseUrl, "auto");

      const run = await runBuiltCli(
        [
          "exec",
          "Inspect this repository and summarize the current implementation status without making changes.",
          "--json",
          "--cwd",
          workspace
        ],
        homeDir
      );
      const payload = JSON.parse(run.stdout) as {
        status: string;
        verification: {
          commands: string[];
          ran: boolean;
          status: string;
        };
      };

      expect(run.exitCode).toBe(0);
      expect(payload.status).toBe("completed");
      expect(payload.verification.commands).toEqual([]);
      expect(payload.verification.ran).toBe(false);
      expect(payload.verification.status).toBe("not_run");
    },
    20_000
  );

  it(
    "runs verification exactly once after a paused patch is resumed",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'ready' ? 0 : 1)\""
        }
      });
      const llm = await createMockLlmServer([
        toolCallResponse("apply_patch", {
          operations: [
            {
              content: "ready\n",
              path: "status.txt",
              type: "create"
            }
          ]
        }),
        finalResponse("Created status.txt and verified it.")
      ]);
      const homeDir = await makeHomeDir(llm.baseUrl);

      const paused = await runBuiltCli(
        [
          "exec",
          "Create status.txt and verify it",
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

      const resumedPayload = JSON.parse(resumed.stdout) as {
        status: string;
        verification: {
          ran: boolean;
          runs: Array<{ command: string; passed: boolean }>;
          status: string;
        };
      };

      expect(resumed.exitCode).toBe(0);
      expect(resumedPayload.status).toBe("completed");
      expect(resumedPayload.verification.ran).toBe(true);
      expect(resumedPayload.verification.status).toBe("passed");
      expect(resumedPayload.verification.runs).toHaveLength(1);
      expect(resumedPayload.verification.runs[0]).toMatchObject({
        command: "npm test",
        passed: true
      });
    },
    20_000
  );

  it(
    "returns exit code 1 when the task remains incomplete because the plan still has pending work",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(0)\""
        }
      });
      const llm = await createMockLlmServer([
        toolCallResponse("write_plan", {
          items: [
            {
              content: "Create backend package",
              status: "completed"
            },
            {
              content: "Create frontend package",
              status: "pending"
            }
          ],
          summary: "Build the requested frontend and backend."
        }),
        finalResponse("Implemented the requested frontend and backend.")
      ]);
      const homeDir = await makeHomeDir(llm.baseUrl, "auto");

      const run = await runBuiltCli(
        ["exec", "Create a frontend and backend app", "--json", "--cwd", workspace],
        homeDir
      );
      const payload = JSON.parse(run.stdout) as { status: string };

      expect(run.exitCode).toBe(1);
      expect(payload.status).toBe("failed");
    },
    20_000
  );

  it(
    "stops after one repair loop when verification keeps failing under a one-step tool budget",
    async () => {
      const workspace = await makeWorkspace({
        packageScripts: {
          test: "node -e \"process.exit(1)\""
        }
      });
      const llm = await createRequestAwareMockLlmServer({
        onRequest(_request, requestIndex) {
          if (requestIndex === 0) {
            return toolCallResponse("apply_patch", {
              operations: [
                {
                  content: "broken\n",
                  path: "status.txt",
                  type: "create"
                }
              ]
            });
          }

          if (requestIndex === 1) {
            return finalResponse("Created the initial implementation.");
          }

          if (requestIndex === 2) {
            return toolCallResponse("apply_patch", {
              operations: [
                {
                  newText: "still-broken\n",
                  oldText: "broken\n",
                  path: "status.txt",
                  type: "replace"
                }
              ]
            });
          }

          if (requestIndex === 3) {
            return finalResponse("Attempted one repair.");
          }

          return finalResponse("Verification is still failing.");
        }
      });
      const homeDir = await makeHomeDir(llm.baseUrl, "auto");

      const run = await runBuiltCli(
        [
          "exec",
          "Create status.txt and keep repairing until npm test passes",
          "--json",
          "--cwd",
          workspace,
          "--max-steps",
          "1"
        ],
        homeDir
      );
      const payload = JSON.parse(run.stdout) as { status: string };

      expect(run.exitCode).toBe(1);
      expect(payload.status).toBe("failed");
      expect(llm.requests.length).toBeLessThanOrEqual(4);
    },
    20_000
  );

});
