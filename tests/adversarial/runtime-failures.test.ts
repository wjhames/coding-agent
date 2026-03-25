import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
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
  createRequestAwareMockLlmServer,
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

  it("does not infer placeholder npm tests after creating a scaffolded package.json", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: JSON.stringify(
              {
                name: "scaffolded-app",
                private: true,
                scripts: {
                  test: "echo \"Error: no test specified\" && exit 1"
                }
              },
              null,
              2
            ),
            path: "package.json",
            type: "create"
          },
          {
            content: "export default function Home() { return <main>Hello</main>; }\n",
            path: "pages/index.js",
            type: "create"
          }
        ]
      }),
      finalResponse("Implemented the requested scaffold.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Create a small scaffolded web app", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
      verification: {
        commands: string[];
        ran: boolean;
        status: string;
      };
    };

    if (payload.status !== "completed" || payload.verification.commands.length > 0) {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(payload, null, 2),
          kind: "verification_stale"
        },
        files: {
          "workspace.json": JSON.stringify(await snapshotWorkspace(workspace), null, 2)
        },
        summary: payload.summary
      });
    }

    expect(payload.status).toBe("completed");
    expect(payload.verification.commands).toEqual([]);
    expect(payload.verification.ran).toBe(false);
    expect(payload.verification.status).toBe("not_run");
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

  it("does not report completed when the current plan still has pending work", async () => {
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
    const payload = JSON.parse(run.stdout) as {
      plan: {
        items: Array<{
          content: string;
          status: string;
        }>;
      } | null;
      status: string;
      summary: string;
    };

    if (payload.status === "completed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(payload.plan, null, 2),
          kind: "completion_false_positive"
        },
        summary: payload.summary
      });
    }

    expect(payload.plan?.items.some((item) => item.status !== "completed")).toBe(true);
    expect(payload.status).not.toBe("completed");
  });

  it("does not report completed when the current plan still has in-progress work", async () => {
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
            content: "Wire frontend routes",
            status: "in_progress"
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
    const payload = JSON.parse(run.stdout) as {
      nextActions: string[];
      plan: {
        items: Array<{
          content: string;
          status: string;
        }>;
      } | null;
      status: string;
      summary: string;
    };

    if (payload.status === "completed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(
            {
              nextActions: payload.nextActions,
              plan: payload.plan
            },
            null,
            2
          ),
          kind: "completion_false_positive"
        },
        summary: payload.summary
      });
    }

    expect(payload.plan?.items.some((item) => item.status === "in_progress")).toBe(true);
    expect(payload.nextActions).toContain("Wire frontend routes");
    expect(payload.status).not.toBe("completed");
  });

  it("does not report completed when the current plan still has in-progress work after partial edits", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("write_plan", {
        items: [
          {
            content: "Create dashboard package",
            status: "completed"
          },
          {
            content: "Create App.jsx",
            status: "in_progress"
          }
        ],
        summary: "Build the dashboard."
      }),
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: "{\"name\":\"dashboard\",\"private\":true}\n",
            path: "dashboard/package.json",
            type: "create"
          }
        ]
      }),
      finalResponse("Implemented the requested dashboard.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Create a dashboard with package.json and App.jsx", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      changedFiles: string[];
      nextActions: string[];
      plan: {
        items: Array<{
          content: string;
          status: string;
        }>;
      } | null;
      status: string;
      summary: string;
      verification: {
        status: string;
      };
    };

    if (payload.status === "completed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(
            {
              changedFiles: payload.changedFiles,
              nextActions: payload.nextActions,
              plan: payload.plan,
              verification: payload.verification
            },
            null,
            2
          ),
          kind: "completion_false_positive"
        },
        files: {
          "workspace.json": JSON.stringify(await snapshotWorkspace(workspace), null, 2)
        },
        summary: payload.summary
      });
    }

    expect(payload.changedFiles).toContain("dashboard/package.json");
    expect(payload.plan?.items.some((item) => item.status === "in_progress")).toBe(true);
    expect(payload.nextActions).toContain("Create App.jsx");
    expect(payload.verification.status).toBe("not_run");
    expect(payload.status).not.toBe("completed");
  });

  it("does not fail completed work solely because stale plan items remain pending", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        test: "node -e \"const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'ready' ? 0 : 1)\""
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("write_plan", {
        items: [
          {
            content: "Create status file",
            status: "completed"
          },
          {
            content: "Add CLI integration",
            status: "pending"
          }
        ],
        summary: "Finish the status workflow and CLI integration."
      }),
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: "ready\n",
            path: "status.txt",
            type: "create"
          }
        ]
      }),
      finalResponse("Implemented the requested status workflow.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Create status.txt and add the CLI integration", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      plan: {
        items: Array<{
          content: string;
          status: string;
        }>;
      } | null;
      status: string;
      summary: string;
      verification: {
        ran: boolean;
        status: string;
      };
    };

    if (payload.status !== "completed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(
            {
              plan: payload.plan,
              verification: payload.verification
            },
            null,
            2
          ),
          kind: "completion_false_negative"
        },
        files: {
          "workspace.json": JSON.stringify(await snapshotWorkspace(workspace), null, 2)
        },
        summary: payload.summary
      });
    }

    expect(payload.verification.ran).toBe(false);
    expect(payload.verification.status).toBe("not_run");
    expect(payload.plan?.items.some((item) => item.status === "pending")).toBe(true);
    expect(payload.status).toBe("completed");
  });

  it("does not report completed when required deliverables are still missing", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: JSON.stringify(
              {
                name: "backend-only",
                private: true
              },
              null,
              2
            ),
            path: "packages/backend/package.json",
            type: "create"
          }
        ]
      }),
      finalResponse("Created the requested frontend and backend app.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      [
        "exec",
        "Create a monorepo with both packages/frontend/package.json and packages/backend/package.json",
        "--json",
        "--cwd",
        workspace
      ],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as { status: string; summary: string };
    const files = await snapshotWorkspace(workspace);

    if (payload.status === "completed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(files, null, 2),
          kind: "missing_deliverable"
        },
        files: {
          "workspace.json": JSON.stringify(files, null, 2)
        },
        summary: payload.summary
      });
    }

    expect(files["packages/backend/package.json"]).toBeDefined();
    expect(files["packages/frontend/package.json"]).toBeUndefined();
    expect(payload.status).not.toBe("completed");
  });

  it("does not report completed when the assistant says approval is still required", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: "module.exports = { ready: true };\n",
            path: "backend/config.js",
            type: "create"
          }
        ]
      }),
      finalResponse(
        "Created the backend config. I need your approval to create backend/server.js before this task can be completed."
      )
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      [
        "exec",
        "Create backend/config.js and backend/server.js for the backend app",
        "--json",
        "--cwd",
        workspace
      ],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
      verification: {
        ran: boolean;
        status: string;
      };
    };

    if (payload.status === "completed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(
            {
              status: payload.status,
              summary: payload.summary,
              verification: payload.verification
            },
            null,
            2
          ),
          kind: "completion_false_positive"
        },
        files: {
          "workspace.json": JSON.stringify(await snapshotWorkspace(workspace), null, 2)
        },
        summary: payload.summary
      });
    }

    expect(payload.verification.ran).toBe(true);
    expect(payload.verification.status).toBe("passed");
    expect(payload.status).not.toBe("completed");
  });

  it("does not fail completed work when the assistant says approval was not required", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: "module.exports = { ready: true };\n",
            path: "backend/config.js",
            type: "create"
          },
          {
            content: "module.exports = { start() { return 'ok'; } };\n",
            path: "backend/server.js",
            type: "create"
          }
        ]
      }),
      finalResponse(
        "Created backend/config.js and backend/server.js. No additional approval was required."
      )
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      [
        "exec",
        "Create backend/config.js and backend/server.js for the backend app",
        "--json",
        "--cwd",
        workspace
      ],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
      verification: {
        ran: boolean;
        status: string;
      };
    };

    if (payload.status !== "completed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(
            {
              status: payload.status,
              summary: payload.summary,
              verification: payload.verification
            },
            null,
            2
          ),
          kind: "completion_false_negative"
        },
        files: {
          "workspace.json": JSON.stringify(await snapshotWorkspace(workspace), null, 2)
        },
        summary: payload.summary
      });
    }

    expect(payload.verification.ran).toBe(true);
    expect(payload.verification.status).toBe("passed");
    expect(payload.status).toBe("completed");
  });

  it("runs verification when it was explicitly requested even without code changes", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        build: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      finalResponse("Installed dependencies, ran the build, and ran the tests successfully.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      [
        "exec",
        "Run the build and tests for this workspace and report the result",
        "--json",
        "--cwd",
        workspace
      ],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
      verification: {
        ran: boolean;
        status: string;
      };
    };

    if (!payload.verification.ran || payload.verification.status !== "passed") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(payload.verification, null, 2),
          kind: "verification_stale"
        },
        summary: payload.summary
      });
    }

    expect(payload.verification.ran).toBe(true);
    expect(payload.verification.status).toBe("passed");
    expect(payload.status).toBe("completed");
  });

  it("does not advertise inferred verification commands to the model for pure inspection tasks", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        build: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createRequestAwareMockLlmServer({
      onRequest() {
        return finalResponse("Inspected the workspace.");
      }
    });
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    await runBuiltCli(["exec", "Inspect this workspace", "--json", "--cwd", workspace], homeDir);
    const firstRequest =
      llm.requests[0]?.body && typeof llm.requests[0].body === "object"
        ? (llm.requests[0].body as { messages?: Array<{ content?: string; role?: string }> })
        : null;
    const systemMessage =
      firstRequest?.messages?.find((message) => message.role === "system")?.content ?? "";

    if (systemMessage.includes("Likely verification commands:")) {
      await captureFailureArtifacts({
        failure: {
          details: systemMessage,
          kind: "verification_stale"
        },
        summary: "inspection prompts should not preload verification commands into the model context"
      });
    }

    expect(systemMessage).not.toContain("Likely verification commands:");
  });

  it("includes explicitly requested build commands in verification planning", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        build: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      finalResponse("Ran the build and tests successfully.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      [
        "exec",
        "Run the build and tests for this workspace and report the result",
        "--json",
        "--cwd",
        workspace
      ],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      summary: string;
      verification: {
        commands: string[];
        selectedCommands: string[];
      };
    };

    if (
      !payload.verification.commands.includes("npm run build") ||
      !payload.verification.selectedCommands.includes("npm run build")
    ) {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(payload.verification, null, 2),
          kind: "verification_stale"
        },
        summary: payload.summary
      });
    }

    expect(payload.verification.commands).toContain("npm run build");
    expect(payload.verification.selectedCommands).toContain("npm run build");
    expect(payload.verification.commands).toContain("npm test");
  });

  it("records session creation no later than the first recorded turn", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([finalResponse("Checked the workspace.")]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(["exec", "Inspect the repo", "--json", "--cwd", workspace], homeDir);
    const payload = JSON.parse(run.stdout) as { sessionId: string; summary: string };
    const session = JSON.parse(
      await readFile(join(homeDir, ".coding-agent", "sessions", `${payload.sessionId}.json`), "utf8")
    ) as {
      createdAt: string;
      turns: Array<{ at: string }>;
    };
    const firstTurnAt = session.turns.reduce(
      (earliest, turn) => (earliest < turn.at ? earliest : turn.at),
      session.turns[0]?.at ?? session.createdAt
    );

    if (Date.parse(session.createdAt) > Date.parse(firstTurnAt)) {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(
            {
              createdAt: session.createdAt,
              firstTurnAt,
              turns: session.turns
            },
            null,
            2
          ),
          kind: "session_persistence_breakage"
        },
        summary: payload.summary
      });
    }

    expect(Date.parse(session.createdAt)).toBeLessThanOrEqual(Date.parse(firstTurnAt));
  });

  it("does not attribute the previous tool summary to a write_plan result", async () => {
    const workspace = await makeWorkspace({
      files: {
        "frontend/package.json": JSON.stringify({ name: "frontend", private: true }, null, 2)
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("read_file", {
        path: "frontend/package.json"
      }),
      toolCallResponse("write_plan", {
        items: [
          {
            content: "Create backend server",
            status: "in_progress"
          }
        ],
        summary: "Set up backend integration."
      }),
      finalResponse("Planned the next backend step.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(["exec", "Read the frontend package and make a plan", "--json", "--cwd", workspace], homeDir);
    const payload = JSON.parse(run.stdout) as { sessionId: string; summary: string };
    const session = JSON.parse(
      await readFile(join(homeDir, ".coding-agent", "sessions", `${payload.sessionId}.json`), "utf8")
    ) as {
      turns: Array<{
        kind: string;
        summary?: string;
        tool?: string;
      }>;
    };
    const planResult = session.turns.find(
      (turn) => turn.kind === "tool_result" && turn.tool === "write_plan"
    );

    if (planResult?.summary !== "write_plan completed.") {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(planResult, null, 2),
          kind: "tool_result_accounting"
        },
        summary: payload.summary
      });
    }

    expect(planResult?.summary).toBe("write_plan completed.");
  });

  it("keeps adjacent read_file and write_plan tool summaries distinct in session history", async () => {
    const workspace = await makeWorkspace({
      files: {
        "frontend/package.json": JSON.stringify({ name: "frontend", private: true }, null, 2)
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("read_file", {
        path: "frontend/package.json"
      }),
      toolCallResponse("write_plan", {
        items: [
          {
            content: "Create backend server",
            status: "in_progress"
          }
        ],
        summary: "Set up backend integration."
      }),
      finalResponse("Planned the next backend step.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(["exec", "Read the frontend package and make a plan", "--json", "--cwd", workspace], homeDir);
    const payload = JSON.parse(run.stdout) as { sessionId: string; summary: string };
    const session = JSON.parse(
      await readFile(join(homeDir, ".coding-agent", "sessions", `${payload.sessionId}.json`), "utf8")
    ) as {
      turns: Array<{
        kind: string;
        summary?: string;
        tool?: string;
      }>;
    };
    const readResult = session.turns.find(
      (turn) => turn.kind === "tool_result" && turn.tool === "read_file"
    );
    const planResult = session.turns.find(
      (turn) => turn.kind === "tool_result" && turn.tool === "write_plan"
    );

    if (
      readResult?.summary !== "Read frontend/package.json lines 1-4." ||
      planResult?.summary !== "write_plan completed."
    ) {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(
            {
              planResult,
              readResult
            },
            null,
            2
          ),
          kind: "tool_result_accounting"
        },
        summary: payload.summary
      });
    }

    expect(readResult?.summary).toBe("Read frontend/package.json lines 1-4.");
    expect(planResult?.summary).toBe("write_plan completed.");
  });

  it("does not persist stale write_plan summaries into historySummary", async () => {
    const workspace = await makeWorkspace({
      files: {
        "frontend/package.json": JSON.stringify({ name: "frontend", private: true }, null, 2)
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("read_file", {
        path: "frontend/package.json"
      }),
      toolCallResponse("write_plan", {
        items: [
          {
            content: "Create backend server",
            status: "in_progress"
          }
        ],
        summary: "Set up backend integration."
      }),
      finalResponse("Planned the next backend step.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(["exec", "Read the frontend package and make a plan", "--json", "--cwd", workspace], homeDir);
    const payload = JSON.parse(run.stdout) as { sessionId: string; summary: string };
    const session = JSON.parse(
      await readFile(join(homeDir, ".coding-agent", "sessions", `${payload.sessionId}.json`), "utf8")
    ) as {
      context: {
        historySummary: string | null;
      };
    };
    const historySummary = session.context.historySummary ?? "";

    if (historySummary.includes("Tool completed write_plan: Read frontend/package.json lines 1-4.")) {
      await captureFailureArtifacts({
        failure: {
          details: historySummary,
          kind: "tool_result_accounting"
        },
        summary: payload.summary
      });
    }

    expect(historySummary).not.toContain(
      "Tool completed write_plan: Read frontend/package.json lines 1-4."
    );
  });

  it("does not pin generated or binary scaffolding files into the model context", async () => {
    const workspace = await makeWorkspace();
    const llm = await createMockLlmServer([
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: "export type PageRoutes = \"/\";\n",
            path: "frontend/.next/types/routes.d.ts",
            type: "create"
          },
          {
            content: "PNGDATA-NOT-SOURCE\n",
            path: "frontend/app/favicon.ico",
            type: "create"
          },
          {
            content: "export default function Page() { return <main>Hello</main>; }\n",
            path: "frontend/app/page.tsx",
            type: "create"
          }
        ]
      }),
      finalResponse("Updated the frontend.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(["exec", "Update the frontend app", "--json", "--cwd", workspace], homeDir);
    const payload = JSON.parse(run.stdout) as {
      context: {
        snippets: Array<{ path: string }>;
        workingSet: Array<{ path: string }>;
      };
      summary: string;
    };
    const pollutedPaths = [
      ...payload.context.workingSet.map((entry) => entry.path),
      ...payload.context.snippets.map((entry) => entry.path)
    ].filter((path) => path.includes("/.next/") || path.endsWith("favicon.ico"));

    if (pollutedPaths.length > 0) {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(
            {
              pollutedPaths,
              context: payload.context
            },
            null,
            2
          ),
          kind: "context_drift"
        },
        files: {
          "workspace.json": JSON.stringify(await snapshotWorkspace(workspace), null, 2)
        },
        summary: payload.summary
      });
    }

    expect(pollutedPaths).toEqual([]);
  });

  it("does not let exec runs write outside the workspace with run_shell", async () => {
    const workspace = await makeWorkspace();
    const outsideDir = await mkdtemp(join(os.tmpdir(), "coding-agent-runtime-escape-"));
    const outsidePath = join(outsideDir, "escape.txt");
    const llm = await createMockLlmServer([
      toolCallResponse("run_shell", {
        command: `printf 'escaped' > '${outsidePath}'`
      }),
      finalResponse("Created the requested file.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    try {
      const run = await runBuiltCli(
        ["exec", `Create the file ${outsidePath}`, "--json", "--cwd", workspace],
        homeDir
      );
      const payload = JSON.parse(run.stdout) as { status: string; summary: string };
      const outsideContents = await readFile(outsidePath, "utf8").catch(() => null);

      if (payload.status === "completed" || outsideContents !== null) {
        await captureFailureArtifacts({
          failure: {
            details: JSON.stringify(
              {
                outsideContents,
                outsidePath,
                status: payload.status
              },
              null,
              2
            ),
            kind: "resume_state_loss"
          },
          summary: payload.summary
        });
      }

      expect(outsideContents).toBeNull();
      expect(payload.status).not.toBe("completed");
    } finally {
      await rm(outsideDir, { force: true, recursive: true });
    }
  });

  it("does not trust a final summary that claims verification ran when records are empty", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        build: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\""
      }
    });
    const llm = await createMockLlmServer([
      finalResponse("Ran the build and tests successfully.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Inspect this workspace", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
      verification: {
        ran: boolean;
        runs: Array<{ command: string }>;
        status: string;
      };
    };

    if (payload.summary.includes("Ran the build and tests successfully.") && !payload.verification.ran) {
      await captureFailureArtifacts({
        failure: {
          details: JSON.stringify(payload.verification, null, 2),
          kind: "verification_stale"
        },
        summary: payload.summary
      });
    }

    expect(payload.summary).toContain("Ran the build and tests successfully.");
    expect(payload.verification.ran).toBe(true);
    expect(payload.verification.runs.length).toBeGreaterThan(0);
  });


  it("keeps running verification across multiple failed repair attempts until a later repair passes", async () => {
    const workspace = await makeWorkspace({
      packageScripts: {
        test: "node -e \"const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'fixed' ? 0 : 1)\""
      }
    });
    const llm = await createMockLlmServer([
      toolCallResponse("apply_patch", {
        operations: [
          {
            content: "broken\n",
            path: "status.txt",
            type: "create"
          }
        ]
      }),
      finalResponse("Created the initial implementation."),
      toolCallResponse("apply_patch", {
        operations: [
          {
            newText: "still-broken\n",
            oldText: "broken\n",
            path: "status.txt",
            type: "replace"
          }
        ]
      }),
      finalResponse("Attempted one repair."),
      toolCallResponse("apply_patch", {
        operations: [
          {
            newText: "fixed\n",
            oldText: "still-broken\n",
            path: "status.txt",
            type: "replace"
          }
        ]
      }),
      finalResponse("Applied the final repair.")
    ]);
    const homeDir = await makeHomeDir(llm.baseUrl, "auto");

    const run = await runBuiltCli(
      ["exec", "Create status.txt and keep repairing until npm test passes", "--json", "--cwd", workspace],
      homeDir
    );
    const payload = JSON.parse(run.stdout) as {
      status: string;
      summary: string;
      verification: {
        ran: boolean;
        runs: Array<{ command: string; exitCode: number; passed: boolean }>;
        status: string;
      };
    };

    if (
      payload.verification.runs.length < 3 ||
      payload.verification.status !== "passed" ||
      payload.status !== "completed"
    ) {
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

    expect(payload.verification.ran).toBe(true);
    expect(payload.verification.runs.length).toBeGreaterThanOrEqual(3);
    expect(payload.verification.runs.at(-1)?.passed).toBe(true);
    expect(payload.verification.status).toBe("passed");
    expect(payload.status).toBe("completed");
  });
});
