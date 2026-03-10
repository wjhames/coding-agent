import { mkdir } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

export function getAgentHome(homeDir = os.homedir()): string {
  const overriddenHome = process.env.CODING_AGENT_HOME;

  if (overriddenHome) {
    return overriddenHome;
  }

  return join(homeDir, ".coding-agent");
}

export function getSessionRoot(homeDir = os.homedir()): string {
  return join(getAgentHome(homeDir), "sessions");
}

export function getSessionFilePath(
  sessionId: string,
  homeDir = os.homedir()
): string {
  return join(getSessionRoot(homeDir), `${sessionId}.json`);
}

export function getSessionEventsFilePath(
  sessionId: string,
  homeDir = os.homedir()
): string {
  return join(getSessionRoot(homeDir), `${sessionId}.events.jsonl`);
}

export async function ensureSessionRoot(homeDir = os.homedir()): Promise<string> {
  const sessionRoot = getSessionRoot(homeDir);
  await mkdir(sessionRoot, { recursive: true });
  return sessionRoot;
}
