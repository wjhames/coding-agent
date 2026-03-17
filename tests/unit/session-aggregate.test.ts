import { describe, expect, it } from "vitest";
import {
  createSessionRecord,
  dedupeArtifacts,
  normalizePaths,
  updateSessionRecord,
  upsertApproval
} from "../../src/session/aggregate.js";

describe("session aggregate", () => {
  it("deduplicates changed files and artifacts in canonical snapshots", () => {
    expect(
      dedupeArtifacts([
        { diff: "a", kind: "diff", path: "src/a.ts" },
        { diff: "b", kind: "diff", path: "src/a.ts" }
      ])
    ).toEqual([{ diff: "b", kind: "diff", path: "src/a.ts" }]);
    expect(normalizePaths(["src/b.ts", "src/a.ts", "src/b.ts"])).toEqual([
      "src/a.ts",
      "src/b.ts"
    ]);
  });

  it("upserts approvals by id", () => {
    expect(
      upsertApproval(
        [
          {
            actionClass: "shell_side_effect",
            command: "npm test",
            id: "approval-1",
            reason: "shell_side_effect",
            status: "pending",
            summary: "Approval required to run shell command: npm test",
            tool: "run_shell"
          }
        ],
        {
          actionClass: "shell_side_effect",
          command: "npm test",
          id: "approval-1",
          reason: "shell_side_effect",
          status: "approved",
          summary: "Approval required to run shell command: npm test",
          tool: "run_shell"
        }
      )
    ).toEqual([
      {
        actionClass: "shell_side_effect",
        command: "npm test",
        id: "approval-1",
        reason: "shell_side_effect",
        status: "approved",
        summary: "Approval required to run shell command: npm test",
        tool: "run_shell"
      }
    ]);
  });

  it("creates and updates canonical session records", () => {
    const created = createSessionRecord({
      id: "session-1",
      input: {
        config: {},
        cwd: "/workspace/project",
        mode: "exec",
        prompt: "inspect repo",
        repoContext: {
          guidanceFiles: [],
          isGitRepo: true,
          packageScripts: {},
          topLevelEntries: [".git"]
        },
        status: "paused",
        summary: "waiting"
      },
      now: "2026-03-16T12:00:00.000Z"
    });

    const updated = updateSessionRecord(
      created,
      {
        config: {},
        context: created.context,
        cwd: created.cwd,
        guidance: created.guidance,
        mode: created.mode,
        prompt: created.prompt,
        repoContext: created.repoContext,
        state: {
          ...created.state,
          changedFiles: ["src/index.ts"],
          nextActions: ["Run npm test"]
        },
        status: "completed",
        summary: "done",
        turns: [
          {
            at: "2026-03-16T12:00:01.000Z",
            id: "turn-1",
            kind: "user",
            text: "inspect repo"
          }
        ]
      },
      "2026-03-16T12:00:02.000Z"
    );

    expect(updated.createdAt).toBe("2026-03-16T12:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-03-16T12:00:02.000Z");
    expect(updated.state.changedFiles).toEqual(["src/index.ts"]);
    expect(updated.turns).toHaveLength(1);
  });
});
