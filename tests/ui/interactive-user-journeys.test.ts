import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  finalResponse,
  toolCallResponse
} from "../helpers/mock-llm.js";
import {
  outputAppearsWithin,
  spawnInteractiveCli,
  typeText,
  waitForExit,
  waitForOutput
} from "../helpers/pty-harness.js";

describe("interactive user journeys", () => {
  afterEach(async () => {
    await cleanupMockLlmServers();
    await cleanupCliHarness();
  });

  it(
    "shows the idle composer when the shell starts",
    async () => {
      const llm = await createMockLlmServer([finalResponse("unused")]);
      const homeDir = await makeHomeDir(llm.baseUrl);
      await ensureBuiltCli();
      const session = spawnInteractiveCli({
        cwd: repoRoot,
        distCli,
        homeDir,
        repoRoot
      });

      try {
        await waitForOutput(session, "Type a task", 8_000);
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "keeps the shell open when Enter is pressed with no draft and no recent sessions",
    async () => {
      const llm = await createMockLlmServer([finalResponse("unused")]);
      const homeDir = await makeHomeDir(llm.baseUrl);
      await ensureBuiltCli();
      const session = spawnInteractiveCli({
        cwd: repoRoot,
        distCli,
        homeDir,
        repoRoot
      });

      try {
        await waitForOutput(session, "Type a task", 8_000);
        session.stdin.write("\r");
        const stillIdle = await outputAppearsWithin(session, "Type a task", 1_000);

        expect(stillIdle).toBe(true);
        expect(session.child.exitCode).toBeNull();
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "shows the resume hint on startup when a recent session exists",
    async () => {
      const workspace = await makeWorkspace();
      const llm = await createMockLlmServer([finalResponse("Inspected the workspace.")]);
      const homeDir = await makeHomeDir(llm.baseUrl);
      await ensureBuiltCli();

      const seedSession = spawnInteractiveCli({
        cwd: workspace,
        distCli,
        homeDir,
        repoRoot
      });

      try {
        await waitForOutput(seedSession, "Type a task", 8_000);
        await typeText(seedSession.stdin, "Inspect this workspace");
        seedSession.stdin.write("\r");
        await waitForOutput(seedSession, "Completed.", 8_000);
      } finally {
        seedSession.stdin.write("\u0003");
        await waitForExit(seedSession.child, 5_000).catch(() => undefined);
      }

      const resumedShell = spawnInteractiveCli({
        cwd: workspace,
        distCli,
        homeDir,
        repoRoot
      });

      try {
        await waitForOutput(resumedShell, "Press Enter on empty input to resume", 8_000);
      } finally {
        resumedShell.stdin.write("\u0003");
        await waitForExit(resumedShell.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );

  it(
    "shows a last-session banner after a completed run is closed with ctrl-c",
    async () => {
      const workspace = await makeWorkspace();
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
        await waitForOutput(session, "Completed.", 8_000);

        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000);

        expect(session.getOutput()).toContain("Last session:");
        expect(session.getOutput()).toContain("(completed)");
      } finally {
        if (session.child.exitCode === null) {
          session.stdin.write("\u0003");
          await waitForExit(session.child, 5_000).catch(() => undefined);
        }
      }
    },
    20_000
  );

  it(
    "lets the user reject a pending approval from the shell without running the side effect",
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

        session.stdin.write("\u001b[B");
        session.stdin.write("\r");

        await waitForOutput(session, "Approval rejected.", 8_000);
        await waitForOutput(session, "Run failed.", 8_000);
        await expect(readFile(join(workspace, "created.txt"), "utf8")).rejects.toThrow();
      } finally {
        session.stdin.write("\u0003");
        await waitForExit(session.child, 5_000).catch(() => undefined);
      }
    },
    20_000
  );
});
