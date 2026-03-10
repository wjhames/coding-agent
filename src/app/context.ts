import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RepoContextSummary } from "../cli/output.js";

export interface RepoContext extends RepoContextSummary {
  packageScripts: Record<string, string>;
  snippets: Array<{
    content: string;
    path: string;
  }>;
}

const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md", "README.md", "package.json"] as const;
const MAX_SNIPPET_BYTES = 4096;
const MAX_TOP_LEVEL_ENTRIES = 12;

export async function collectRepoContext(cwd: string): Promise<RepoContext> {
  const entries = (await readdir(cwd)).sort();
  const topLevelEntries = entries.slice(0, MAX_TOP_LEVEL_ENTRIES);
  const guidanceFiles = (
    await Promise.all(
      GUIDANCE_FILES.filter((name) => entries.includes(name)).map(async (name) =>
        (await isRegularFile(join(cwd, name))) ? name : null
      )
    )
  ).filter((name): name is (typeof GUIDANCE_FILES)[number] => name !== null);
  const snippets = await Promise.all(
    guidanceFiles.map(async (path) => ({
      content: await readSnippet(join(cwd, path)),
      path
    }))
  );
  const isGitRepo = await hasPath(join(cwd, ".git"));

  return {
    guidanceFiles,
    isGitRepo,
    packageScripts: extractPackageScripts(
      snippets.find((snippet) => snippet.path === "package.json")?.content
    ),
    snippets,
    topLevelEntries
  };
}

async function readSnippet(path: string): Promise<string> {
  const contents = await readFile(path, "utf8");
  return contents.slice(0, MAX_SNIPPET_BYTES);
}

function extractPackageScripts(contents: string | undefined): Record<string, string> {
  if (!contents) {
    return {};
  }

  try {
    const parsed = JSON.parse(contents) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

async function hasPath(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
