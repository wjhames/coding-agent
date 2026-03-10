import { readFile } from "node:fs/promises";
import { walkWorkspaceFiles } from "../tools/workspace.js";

export async function snapshotWorkspace(args: {
  cwd: string;
}): Promise<Map<string, string>> {
  const files = await walkWorkspaceFiles({
    cwd: args.cwd,
    limit: 2000,
    path: "."
  });
  const snapshot = new Map<string, string>();

  for (const file of files) {
    try {
      snapshot.set(file, await readFile(`${args.cwd}/${file}`, "utf8"));
    } catch {
      // Skip unreadable/binary files for V1 diff tracking.
    }
  }

  return snapshot;
}

export function diffWorkspaceSnapshots(args: {
  after: Map<string, string>;
  before: Map<string, string>;
}): string[] {
  const paths = new Set<string>([...args.before.keys(), ...args.after.keys()]);
  return [...paths].filter((path) => args.before.get(path) !== args.after.get(path)).sort();
}
