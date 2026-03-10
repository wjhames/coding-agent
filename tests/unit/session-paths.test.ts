import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSessionRoot,
  getAgentHome,
  getSessionFilePath,
  getSessionRoot
} from "../../src/session/paths.js";

const tempDirs: string[] = [];

describe("session paths", () => {
  const originalAgentHome = process.env.CODING_AGENT_HOME;

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
    restoreAgentHome(originalAgentHome);
  });

  it("builds the default storage paths from the home directory", () => {
    expect(getAgentHome("/tmp/home")).toBe("/tmp/home/.coding-agent");
    expect(getSessionRoot("/tmp/home")).toBe("/tmp/home/.coding-agent/sessions");
    expect(getSessionFilePath("abc123", "/tmp/home")).toBe(
      "/tmp/home/.coding-agent/sessions/abc123.json"
    );
  });

  it("creates the session root directory", async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), "coding-agent-home-"));
    tempDirs.push(homeDir);

    const sessionRoot = await ensureSessionRoot(homeDir);
    const stats = await stat(sessionRoot);

    expect(stats.isDirectory()).toBe(true);
    expect(sessionRoot).toBe(join(homeDir, ".coding-agent", "sessions"));
  });

  it("prefers CODING_AGENT_HOME when provided", () => {
    process.env.CODING_AGENT_HOME = "/tmp/custom-agent-home";

    expect(getAgentHome("/tmp/ignored-home")).toBe("/tmp/custom-agent-home");
    expect(getSessionRoot("/tmp/ignored-home")).toBe("/tmp/custom-agent-home/sessions");
  });
});

function restoreAgentHome(value: string | undefined) {
  if (value === undefined) {
    delete process.env.CODING_AGENT_HOME;
    return;
  }

  process.env.CODING_AGENT_HOME = value;
}
