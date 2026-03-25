import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { classifyPatchAction, enforceApproval } from "../app/approval.js";
import { createDiffArtifact, readMaybeFile } from "../app/diff.js";
import type { ResolvedExecutionConfig } from "../config/load.js";
import type { Approval, Artifact, Observation } from "../runtime/contracts.js";
import type { LlmTool } from "../llm/openai-client.js";
import { resolveWorkspacePath, toWorkspaceRelativePath } from "./workspace.js";

export const patchOperationSchema = z.discriminatedUnion("type", [
  z.object({
    newText: z.string(),
    oldText: z.string(),
    path: z.string().min(1),
    type: z.literal("replace")
  }),
  z.object({
    content: z.string(),
    path: z.string().min(1),
    type: z.literal("create")
  }),
  z.object({
    path: z.string().min(1),
    type: z.literal("delete")
  })
]);

const applyPatchInputSchema = z.object({
  operations: z.array(patchOperationSchema).min(1).max(12)
});

export type PatchOperation = z.infer<typeof patchOperationSchema>;
export type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;

export function createApplyPatchTool(args: {
  addApproval: (approval: Approval) => void;
  addArtifacts: (artifacts: Artifact[]) => void;
  addChangedFiles: (files: string[]) => void;
  addObservation: (observation: Observation) => void;
  config: ResolvedExecutionConfig;
  cwd: string;
}): LlmTool {
  return {
    description: "Apply file changes inside the workspace.",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["replace"] },
                  path: { type: "string" },
                  oldText: { type: "string" },
                  newText: { type: "string" }
                },
                required: ["type", "path", "oldText", "newText"]
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["create"] },
                  path: { type: "string" },
                  content: { type: "string" }
                },
                required: ["type", "path", "content"]
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["delete"] },
                  path: { type: "string" }
                },
                required: ["type", "path"]
              }
            ]
          }
        }
      },
      required: ["operations"]
    },
    inputSchema: applyPatchInputSchema,
    name: "apply_patch",
    async run(input, context) {
      const parsed = applyPatchInputSchema.parse(input);
      const approval = enforceApproval({
        action: parsed,
        actionClass: classifyPatchAction(parsed.operations),
        config: args.config,
        reason: "file_write",
        requiresApproval: args.config.approvalPolicy !== "auto",
        summary: `Approval required to apply ${parsed.operations.length} patch operation(s).`,
        tool: "apply_patch",
        toolCallId: context?.toolCallId
      });

      if (approval) {
        args.addApproval(approval);
      }

      return applyPatchOperations({
        addArtifacts: args.addArtifacts,
        addChangedFiles: args.addChangedFiles,
        addObservation: args.addObservation,
        cwd: args.cwd,
        operations: parsed.operations
      });
    }
  };
}

export async function applyPatchOperations(args: {
  addArtifacts: (artifacts: Artifact[]) => void;
  addChangedFiles: (files: string[]) => void;
  addObservation: (observation: Observation) => void;
  cwd: string;
  operations: PatchOperation[];
}): Promise<string> {
  const staged = await stagePatchOperations(args.cwd, args.operations);
  const changedFiles = new Set<string>();
  const artifacts: Artifact[] = [];
  const appliedPaths = new Set<string>();

  try {
    for (const operation of staged) {
      await applyPlannedOperation(operation);
      appliedPaths.add(operation.resolvedPath);
    }
  } catch (error) {
    await rollbackPatchOperations(staged, appliedPaths);
    throw error;
  }

  for (const operation of staged) {
    const artifact = await createDiffArtifact({
      after: operation.after,
      before: operation.before,
      path: operation.relativePath
    });
    changedFiles.add(artifact.path);
    artifacts.push(artifact);
  }

  args.addChangedFiles([...changedFiles]);
  args.addArtifacts(artifacts);
  args.addObservation({
    excerpt: artifacts.map((artifact) => artifact.diff).join("\n\n").slice(0, 16_000),
    summary: `Applied patch to ${changedFiles.size} file(s).`,
    tool: "apply_patch"
  });

  return JSON.stringify({
    artifacts,
    changedFiles: [...changedFiles].sort(),
    ok: true,
    operationCount: args.operations.length
  });
}

interface PlannedPatchOperation {
  after: string | null;
  before: string | null;
  relativePath: string;
  resolvedPath: string;
}

async function stagePatchOperations(
  cwd: string,
  operations: PatchOperation[]
): Promise<PlannedPatchOperation[]> {
  const originalContents = new Map<string, string | null>();
  const currentContents = new Map<string, string | null>();
  const staged: PlannedPatchOperation[] = [];

  for (const operation of operations) {
    const resolvedPath = resolveWorkspacePath(cwd, operation.path);
    const relativePath = toWorkspaceRelativePath(cwd, operation.path);

    if (!originalContents.has(resolvedPath)) {
      const before = await readMaybeFile(resolvedPath);
      originalContents.set(resolvedPath, before);
      currentContents.set(resolvedPath, before);
    }

    const before = currentContents.get(resolvedPath) ?? null;
    const after = planOperation(before, operation);
    currentContents.set(resolvedPath, after);
    staged.push({
      after,
      before,
      relativePath,
      resolvedPath
    });
  }

  return staged;
}

function planOperation(
  before: string | null,
  operation: PatchOperation
): string | null {
  if (operation.type === "replace") {
    if (before === null) {
      throw new Error(`Cannot replace text in missing file \`${operation.path}\`.`);
    }

    const matchCount = countOccurrences(before, operation.oldText);
    if (matchCount === 0) {
      throw new Error(`Old text was not found in \`${operation.path}\`.`);
    }

    if (matchCount !== 1) {
      throw new Error(`Old text must match exactly once in \`${operation.path}\`.`);
    }

    return before.replace(operation.oldText, operation.newText);
  }

  if (operation.type === "create") {
    if (before !== null) {
      throw new Error(`Cannot create \`${operation.path}\`` + " because it already exists.");
    }

    return operation.content;
  }

  if (before === null) {
    throw new Error(`Cannot delete missing file \`${operation.path}\`.`);
  }

  return null;
}

async function applyPlannedOperation(operation: PlannedPatchOperation): Promise<void> {
  if (operation.after === null) {
    await rm(operation.resolvedPath, { force: true });
    return;
  }

  await mkdir(dirname(operation.resolvedPath), { recursive: true });
  await writeFile(operation.resolvedPath, operation.after, "utf8");
}

async function rollbackPatchOperations(
  operations: PlannedPatchOperation[],
  appliedPaths: Set<string>
): Promise<void> {
  const originals = new Map<string, string | null>();

  for (const operation of operations) {
    if (!appliedPaths.has(operation.resolvedPath) || originals.has(operation.resolvedPath)) {
      continue;
    }

    originals.set(operation.resolvedPath, operation.before);
  }

  for (const [resolvedPath, before] of originals) {
    if (before === null) {
      await rm(resolvedPath, { force: true });
      continue;
    }

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, before, "utf8");
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;

  while (index <= haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) {
      break;
    }

    count += 1;
    index = next + needle.length;
  }

  return count;
}
