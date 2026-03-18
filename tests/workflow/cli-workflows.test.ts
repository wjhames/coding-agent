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

});
