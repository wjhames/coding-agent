import { afterEach, describe, expect, it } from "vitest";
import { captureFailureArtifacts, cleanupFailureArtifacts } from "../helpers/artifact-capture.js";
import {
  cleanupCliHarness,
  makeHomeDir,
  makeWorkspace,
  runBuiltCli
} from "../helpers/cli-harness.js";
import {
  cleanupMockLlmServers,
  createMockLlmServer,
  finalResponse,
  toolCallResponse
} from "../helpers/mock-llm.js";

describe("adversarial verification completion", () => {
  afterEach(async () => {
    await cleanupMockLlmServers();
    await cleanupCliHarness();
    await cleanupFailureArtifacts();
  });

  it("runs inferred verification commands for no-change test tasks before reporting completion", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      finalResponse("Ran the tests successfully.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Run the tests for this workspace and report the result", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
      verification: {
        notRunReason: string | null;
        ran: boolean;
        status: string;
      };
    };

    if (!payload.verification.ran || payload.verification.status !== "passed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(payload, null, 2),
          kind: "verification_stale"
        },
        summary: payload.summary
      });
    }

    expect(payload.verification.ran).toBe(true);
    expect(payload.verification.status).toBe("passed");
    expect(payload.status).toBe("completed");
    expect(payload.verification.notRunReason).toBeNull();
  });

  it("treats matching run_shell verification commands as verification runs", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: "npm test",
        justification: "Run the workspace tests"
      }),
      finalResponse("Ran the tests successfully.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Run the tests for this workspace and report the result", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      summary: string;
      verification: {
        ran: boolean;
        runs: Array<{
          command: string;
          passed: boolean;
        }>;
        status: string;
      };
    };

    if (!payload.verification.ran || payload.verification.status !== "passed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(payload, null, 2),
          kind: "verification_stale"
        },
        summary: payload.summary
      });
    }

    expect(payload.verification.ran).toBe(true);
    expect(payload.verification.status).toBe("passed");
    expect(payload.verification.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "npm test",
          passed: true
        })
      ])
    );
  });
});
