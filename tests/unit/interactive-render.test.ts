import { describe, expect, it } from "vitest";
import { renderInteractiveScreen } from "../../src/interactive/render.js";
import { createInitialInteractiveState } from "../../src/interactive/state.js";

describe("interactive render", () => {
  it("renders a transcript-first layout with footer metadata", () => {
    const state = createInitialInteractiveState({
      cwd: "/workspace/project",
      doctor: {
        configPresent: true,
        defaultProfile: "local",
        llmReady: true,
        model: "gpt-4.1-mini",
        profiles: ["local"],
        sessionHome: "/tmp/home"
      },
      recentSessions: []
    });

    const screen = renderInteractiveScreen({
      columns: 140,
      rows: 30,
      state: {
        ...state,
        changedFiles: ["src/config.ts"],
        transcript: [
          ...state.transcript,
          {
            body: "inspect the repo",
            id: "user-1",
            kind: "user",
            title: "You"
          },
          {
            body: "Changed: src/config.ts",
            id: "tool-1",
            kind: "tool",
            title: "[apply_patch] result"
          }
        ],
        footerMessage: "Ready.",
        runtimeStatus: "completed"
      }
    });

    expect(screen).toContain("inspect the repo");
    expect(screen).toContain("src/config.ts");
    expect(screen).toContain("status:");
    expect(screen).toContain("profile:local");
    expect(screen).toContain("Ready.");
  });
});
