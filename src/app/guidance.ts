import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GuidanceSummary } from "../cli/output.js";
import { getAgentHome } from "../session/paths.js";

export interface GuidanceLayer {
  content: string;
  path: string;
  priority: number;
  rules: string[];
  source: "home" | "repo" | "task";
}

export interface LoadedGuidance {
  layers: GuidanceLayer[];
  summary: GuidanceSummary;
}

const HOME_GUIDANCE_FILE = "AGENTS.md";
const REPO_GUIDANCE_FILES = [
  { name: "AGENTS.md", priority: 240 },
  { name: "CLAUDE.md", priority: 220 },
  { name: "README.md", priority: 120 }
] as const;
const MAX_GUIDANCE_BYTES = 4096;
const MAX_ACTIVE_RULES = 12;

export async function loadGuidance(args: {
  cwd: string;
  homeDir?: string | undefined;
  prompt: string;
  repoGuidanceFiles: string[];
}): Promise<LoadedGuidance> {
  const taskLayer = createTaskGuidance(args.prompt);
  const homeLayer = await loadHomeGuidance(args.homeDir);
  const repoLayers = (
    await Promise.all(
      REPO_GUIDANCE_FILES.filter((file) => args.repoGuidanceFiles.includes(file.name)).map(
        async ({ name, priority }) => {
          try {
            const content = await readGuidanceFile(join(args.cwd, name));
            return createGuidanceLayer({
              content,
              path: name,
              priority,
              source: "repo"
            });
          } catch (error) {
            if (
              isIgnorableGuidanceReadError(error)
            ) {
              return null;
            }

            throw error;
          }
        }
      )
    )
  ).filter((layer): layer is GuidanceLayer => layer !== null);
  const layers = [taskLayer, ...(homeLayer ? [homeLayer] : []), ...repoLayers].filter(
    (layer) => layer.rules.length > 0
  );

  return {
    layers,
    summary: {
      activeRules: collectActiveRules(layers),
      sources: layers.map((layer) => ({
        path: layer.path,
        priority: layer.priority,
        source: layer.source
      }))
    }
  };
}

async function loadHomeGuidance(homeDir?: string): Promise<GuidanceLayer | null> {
  try {
    const content = await readGuidanceFile(join(getAgentHome(homeDir), HOME_GUIDANCE_FILE));
    return createGuidanceLayer({
      content,
      path: `~/.coding-agent/${HOME_GUIDANCE_FILE}`,
      priority: 260,
      source: "home"
    });
  } catch (error) {
    if (isIgnorableGuidanceReadError(error)) {
      return null;
    }

    throw error;
  }
}

async function readGuidanceFile(path: string): Promise<string> {
  const fileStat = await stat(path);

  if (!fileStat.isFile()) {
    throw new Error(`Guidance path is not a file: \`${path}\`.`);
  }

  const content = await readFile(path, "utf8");
  return content.slice(0, MAX_GUIDANCE_BYTES);
}

function createTaskGuidance(prompt: string): GuidanceLayer {
  return createGuidanceLayer({
    content: prompt,
    path: "task",
    priority: 300,
    source: "task"
  });
}

function createGuidanceLayer(input: {
  content: string;
  path: string;
  priority: number;
  source: "home" | "repo" | "task";
}): GuidanceLayer {
  return {
    content: input.content,
    path: input.path,
    priority: input.priority,
    rules: normalizeRules(input.content),
    source: input.source
  };
}

function normalizeRules(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !["```", "---"].includes(line))
    .map((line) => line.replace(/^[-*]\s+/, ""))
    .slice(0, MAX_ACTIVE_RULES);
}

function collectActiveRules(layers: GuidanceLayer[]): string[] {
  const seen = new Set<string>();
  const activeRules: string[] = [];

  for (const layer of [...layers].sort((left, right) => right.priority - left.priority)) {
    for (const rule of layer.rules) {
      if (seen.has(rule)) {
        continue;
      }

      seen.add(rule);
      activeRules.push(rule);

      if (activeRules.length >= MAX_ACTIVE_RULES) {
        return activeRules;
      }
    }
  }

  return activeRules;
}

function isIgnorableGuidanceReadError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EISDIR")
  ) {
    return true;
  }

  return error instanceof Error && error.message.startsWith("Guidance path is not a file:");
}
