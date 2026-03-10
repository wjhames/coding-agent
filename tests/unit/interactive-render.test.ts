import { describe, expect, it } from "vitest";
import { renderInteractiveScreen } from "../../src/interactive/render.js";
import { createInitialInteractiveState } from "../../src/interactive/state.js";

describe("interactive render", () => {
  it("renders header, transcript, and sidebar sections", () => {
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
        footerMessage: "Ready.",
        runtimeStatus: "completed"
      }
    });

    expect(screen).toContain("coding-agent");
    expect(screen).toContain("Plan");
    expect(screen).toContain("Working Set");
    expect(screen).toContain("src/config.ts");
    expect(screen).toContain("Ready.");
  });
});
