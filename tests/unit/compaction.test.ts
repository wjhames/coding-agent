import { describe, expect, it } from "vitest";
import { deriveCompaction } from "../../src/app/compaction.js";

describe("deriveCompaction", () => {
  it("creates stable summaries for long observation and event histories", () => {
    const compaction = deriveCompaction({
      changedFiles: ["src/a.ts", "src/b.ts"],
      events: Array.from({ length: 9 }, (_, index) => ({
        at: `2026-03-10T00:00:0${index}.000Z`,
        data: {
          nextActions: [],
          summary: `step-${index}`
        },
        eventId: `event-${index}`,
        type: "summary_updated" as const
      })),
      observations: Array.from({ length: 7 }, (_, index) => ({
        summary: `observation-${index}`
      })),
      verification: {
        commands: ["npm test"],
        inferred: true,
        passed: false,
        runs: [
          {
            command: "npm test",
            exitCode: 1,
            passed: false,
            stderr: "failed",
            stdout: ""
          }
        ]
      }
    });

    expect(compaction).toEqual({
      changedFilesSummary: "Changed files: src/a.ts, src/b.ts",
      eventSummary:
        "Recent event flow: summary_updated -> summary_updated -> summary_updated -> summary_updated -> summary_updated -> summary_updated -> summary_updated -> summary_updated",
      observationSummary: "Earlier observations: observation-0 | observation-1 | observation-2",
      verificationSummary: "fail:npm test"
    });
  });
});
