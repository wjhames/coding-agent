import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "coverage"]);

export function resolveWorkspacePath(cwd: string, requestedPath = "."): string {
  const resolvedPath = resolve(cwd, requestedPath);
  const relativePath = relative(cwd, resolvedPath);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith("../")
  ) {
    throw new Error("Requested path is outside the workspace.");
  }

  return resolvedPath;
}

export async function walkWorkspaceFiles(args: {
  cwd: string;
  limit: number;
  path: string | undefined;
}): Promise<string[]> {
  const root = resolveWorkspacePath(args.cwd, args.path);
  const files: string[] = [];
  const requestedPath = args.path ?? ".";

  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Requested path was not found: \`${requestedPath}\`.`);
    }

    throw error;
  }

  if (rootStat.isFile()) {
    return [relative(args.cwd, root)].sort();
  }

  if (!rootStat.isDirectory()) {
    throw new Error(`Requested path is not a file or directory: \`${requestedPath}\`.`);
  }

  await walk(root, files, args.limit);

  return files.map((file) => relative(args.cwd, file)).sort();
}

export async function readWorkspaceTextFile(args: {
  cwd: string;
  maxBytes: number;
  path: string;
}): Promise<string> {
  const resolvedPath = resolveWorkspacePath(args.cwd, args.path);

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Requested path was not found: \`${args.path}\`.`);
    }

    throw error;
  }

  if (!fileStat.isFile()) {
    throw new Error(`Requested path is not a file: \`${args.path}\`.`);
  }

  let contents: string;
  try {
    contents = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Requested path was not found: \`${args.path}\`.`);
    }

    throw error;
  }

  return contents.slice(0, args.maxBytes);
}

async function walk(currentPath: string, files: string[], limit: number): Promise<void> {
  if (files.length >= limit) {
    return;
  }

  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (files.length >= limit) {
      return;
    }

    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) {
        continue;
      }

      await walk(resolve(currentPath, entry.name), files, limit);
      continue;
    }

    if (entry.isFile()) {
      files.push(resolve(currentPath, entry.name));
    }
  }
}
