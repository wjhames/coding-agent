import { afterEach, describe, expect, it } from "vitest";
import { captureFailureArtifacts, cleanupFailureArtifacts } from "../helpers/artifact-capture.js";
import {
  cleanupCliHarness,
  makeHomeDir,
  makeWorkspace,
  runBuiltCli,
  snapshotWorkspace
} from "../helpers/cli-harness.js";
import {
  createMockLlmServer,
  finalResponse,
  toolCallResponse,
  cleanupMockLlmServers
} from "../helpers/mock-llm.js";
import {
  contaminatedSummaryResponse,
  incompleteSummaryResponse
} from "../helpers/model-scripts.js";

describe("adversarial runtime failures", () => {
  afterEach(async () => {
    await cleanupMockLlmServers();
    await cleanupCliHarness();
    await cleanupFailureArtifacts();
  });

  it("sanitizes raw tool-call markup out of the final summary", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      contaminatedSummaryResponse("Implemented the requested change.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(["exec", "Inspect the repo", "--json", "--cwd", workspace], homeDir);
    const payload = JSON.parse(run.stdout) as { summary: string };

    if (payload.summary.includes("<tool_call>") || payload.summary.includes("<function=")) {
      await captureFailureArtifacts({
        failure: {
          details: payload.summary,
          kind: "summary_contamination"
        },
        summary: "final summary leaked raw tool-call markup"
      });
    }

    expect(payload.summary).not.toContain("<tool_call>");
    expect(payload.summary).not.toContain("<function=");
  });

  it("refreshes verification planning after package.json is created mid-run", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: JSON.stringify(
              {
                name: "adversarial-verification",
                private: true,
                scripts: {
                  test: "node -e \"process.exit(0)\""
                }
              },
              null,
              2
            ),
            path: "package.json",
            type: "create"
          }
        ]
      }),
      finalResponse("Created package.json and verification should run.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Create package.json with a test script and verify it", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      summary: string;
      verification: {
        commands: string[];
        ran: boolean;
        status: string;
      };
    };

    if (!payload.verification.commands.includes("npm test") || !payload.verification.ran) {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(payload.verification, null, 2),
          kind: "verification_stale"
        },
        files: {
          "workspace.json": JSON.stringify(await snapshotWorkspace(workspace), null, 2)
        },
        summary: payload.summary
      });
    }

    expect(payload.verification.commands).toContain("npm test");
    expect(payload.verification.ran).toBe(true);
    expect(payload.verification.status).toBe("passed");
  });

  it("does not report completed when the assistant explicitly says work remains", async () => {
    const workspace = await makeWorkspace({
      files: {
        "src/notes.js": "export function listNotes() { return []; }\n"
      },
      packageScripts: {
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      incompleteSummaryResponse(
        "Implemented searchNotes in the library. Remaining tasks: wire the CLI command and add tests."
      )
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Add searchNotes, wire the CLI, and add tests", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as { status: string; summary: string };

    if (payload.status === "completed") {
      await captureFailureArtifacts({
        failure: {
          details: payload.summary,
          kind: "completion_false_positive"
        },
        files: {
          "workspace.json": JSON.stringify(await snapshotWorkspace(workspace), null, 2)
        },
        summary: payload.summary
      });
    }

    expect(payload.status).not.toBe("completed");
  });
});
