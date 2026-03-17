import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
  Observation,
  RepoContextSummary,
  TurnRecord,
  VerificationSummary,
  WorkingSetEntry,
  ContextSnippet
} from "../runtime/contracts.js";
import { readWorkspaceTextFile, walkWorkspaceFiles } from "../tools/workspace.js";

export interface RepoContext extends RepoContextSummary {
  snippets: Array<{
    content: string;
    path: string;
  }>;
}

const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md", "README.md", "package.json"] as const;
const MAX_SNIPPET_BYTES = 4096;
const MAX_TOP_LEVEL_ENTRIES = 12;
const MAX_RETRIEVAL_FILES = 300;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "with"
]);

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
  const snippets = (
    await Promise.all(
      guidanceFiles.map(async (path) => {
        const content = await readSnippet(join(cwd, path));

        if (content === null) {
          return null;
        }

        return {
          content,
          path
        };
      })
    )
  ).filter(
    (snippet): snippet is { content: string; path: (typeof GUIDANCE_FILES)[number] } =>
      snippet !== null
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

export function deriveWorkingSet(args: {
  changedFiles: string[];
  observations: Observation[];
  prompt: string;
  repoContext: RepoContext;
  turns: TurnRecord[];
  verification: VerificationSummary;
}): WorkingSetEntry[] {
  const scores = new Map<string, WorkingSetEntry>();
  const explicitPaths = parsePathReferences([
    args.prompt,
    ...args.turns
      .filter((turn) => turn.kind === "user")
      .slice(-4)
      .map((turn) => ("text" in turn ? turn.text : ""))
  ]);

  for (const path of args.changedFiles) {
    upsertWorkingSet(scores, {
      path,
      pinned: true,
      reason: "Changed in the current session.",
      score: 120,
      source: "changed"
    });
  }

  for (const path of explicitPaths) {
    upsertWorkingSet(scores, {
      path,
      pinned: true,
      reason: "Explicitly named in the conversation.",
      score: 110,
      source: "explicit"
    });
  }

  for (const observation of args.observations.slice(-8)) {
    const explicitObservationPath = observation.path?.trim();

    if (explicitObservationPath) {
      upsertWorkingSet(scores, {
        path: explicitObservationPath,
        pinned: observation.tool === "read_file",
        reason: observation.summary,
        score: observation.tool === "read_file" ? 90 : observation.tool === "search_files" ? 70 : 60,
        source: observation.tool === "search_files" ? "search" : "read"
      });
    }

    if (observation.tool === "search_files") {
      for (const match of parseMatchPaths(observation.excerpt)) {
        upsertWorkingSet(scores, {
          path: match,
          pinned: false,
          reason: `Matched search result for "${observation.query ?? ""}".`.trim(),
          score: 65,
          source: "search"
        });
      }
    }
  }

  if (args.verification.status === "failed") {
    for (const run of args.verification.runs.filter((run) => !run.passed)) {
      for (const path of parsePathReferences([run.stdout, run.stderr])) {
        upsertWorkingSet(scores, {
          path,
          pinned: true,
          reason: `Referenced by failing verification command: ${run.command}`,
          score: 100,
          source: "verification"
        });
      }
    }
  }

  for (const guidanceFile of args.repoContext.guidanceFiles) {
    upsertWorkingSet(scores, {
      path: guidanceFile,
      pinned: false,
      reason: "Guidance file for the workspace.",
      score: 40,
      source: "guidance"
    });
  }

  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 10);
}

export async function collectContextSnippets(args: {
  cwd: string;
  prompt: string;
  turns: TurnRecord[];
  workingSet: WorkingSetEntry[];
}): Promise<ContextSnippet[]> {
  const queryTokens = buildQueryTokens([
    args.prompt,
    ...args.turns
      .filter(
        (turn): turn is Extract<TurnRecord, { kind: "assistant" | "user" | "system_note" }> =>
          turn.kind === "assistant" || turn.kind === "system_note" || turn.kind === "user"
      )
      .slice(-6)
      .map((turn) => turn.text)
  ]);
  const files = await walkWorkspaceFiles({
    cwd: args.cwd,
    limit: MAX_RETRIEVAL_FILES,
    path: "."
  });
  const ranked = rankWorkspaceFiles({
    files,
    queryTokens,
    workingSet: args.workingSet
  });
  const snippets: ContextSnippet[] = [];

  for (const candidate of ranked.slice(0, 8)) {
    const contents = await readWorkspaceTextFile({
      cwd: args.cwd,
      maxBytes: 24_000,
      path: candidate.path
    }).catch(() => null);

    if (contents === null) {
      continue;
    }

    snippets.push(
      extractSnippet({
        contents,
        path: candidate.path,
        queryTokens,
        reason: candidate.reason
      })
    );
  }

  return snippets;
}

function rankWorkspaceFiles(args: {
  files: string[];
  queryTokens: string[];
  workingSet: WorkingSetEntry[];
}): Array<{ path: string; reason: string; score: number }> {
  const byPath = new Map<string, { path: string; reason: string; score: number }>();

  for (const entry of args.workingSet) {
    byPath.set(entry.path, {
      path: entry.path,
      reason: entry.reason,
      score: entry.score + (entry.pinned ? 20 : 0)
    });
  }

  for (const file of args.files) {
    const current = byPath.get(file) ?? {
      path: file,
      reason: "Lexical retrieval candidate.",
      score: 0
    };
    const pathTokens = tokenizePath(file);
    current.score += scorePathTokens(pathTokens, args.queryTokens);

    if (basename(file).toLowerCase() === "package.json") {
      current.score += 8;
    }

    if (file.startsWith("src/")) {
      current.score += 4;
    }

    byPath.set(file, current);
  }

  return [...byPath.values()]
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function extractSnippet(args: {
  contents: string;
  path: string;
  queryTokens: string[];
  reason: string;
}): ContextSnippet {
  const lines = args.contents.split("\n");
  const firstMatchIndex = findSnippetAnchor(lines, args.queryTokens);
  const startLine = Math.max(1, firstMatchIndex + 1 - 4);
  const endLine = Math.min(lines.length, startLine + 23);
  const excerpt = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");

  return {
    endLine,
    excerpt,
    path: args.path,
    reason: args.reason,
    startLine
  };
}

function findSnippetAnchor(lines: string[], queryTokens: string[]): number {
  for (const token of queryTokens) {
    const index = lines.findIndex((line) => line.toLowerCase().includes(token));

    if (index !== -1) {
      return index;
    }
  }

  return 0;
}

function buildQueryTokens(chunks: string[]): string[] {
  return [...new Set(
    chunks
      .flatMap((chunk) => chunk.split(/[^A-Za-z0-9_./-]+/))
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
  )].slice(0, 20);
}

function parsePathReferences(chunks: string[]): string[] {
  const matches = new Set<string>();
  const pattern = /\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\b|\b[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g;

  for (const chunk of chunks) {
    for (const match of chunk.matchAll(pattern)) {
      const candidate = match[0];

      if (!candidate) {
        continue;
      }

      if (candidate.startsWith("http")) {
        continue;
      }

      if (!candidate.includes("/") && extname(candidate).length === 0) {
        continue;
      }

      matches.add(candidate);
    }
  }

  return [...matches];
}

function parseMatchPaths(excerpt: string): string[] {
  const matches = new Set<string>();

  for (const line of excerpt.split("\n")) {
    const separator = line.indexOf(":");

    if (separator <= 0) {
      continue;
    }

    matches.add(line.slice(0, separator));
  }

  return [...matches];
}

function tokenizePath(path: string): string[] {
  return path
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

function scorePathTokens(pathTokens: string[], queryTokens: string[]): number {
  let score = 0;

  for (const token of queryTokens) {
    if (pathTokens.includes(token)) {
      score += 18;
      continue;
    }

    if (pathTokens.some((pathToken) => pathToken.includes(token) || token.includes(pathToken))) {
      score += 8;
    }
  }

  return score;
}

function upsertWorkingSet(
  target: Map<string, WorkingSetEntry>,
  next: WorkingSetEntry
): void {
  const current = target.get(next.path);

  if (!current || next.score > current.score) {
    target.set(next.path, next);
    return;
  }

  if (next.pinned && !current.pinned) {
    target.set(next.path, {
      ...current,
      pinned: true,
      reason: next.reason,
      score: next.score
    });
  }
}

async function readSnippet(path: string): Promise<string | null> {
  try {
    const contents = await readFile(path, "utf8");
    return contents.slice(0, MAX_SNIPPET_BYTES);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    ) {
      return null;
    }

    throw error;
  }
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
