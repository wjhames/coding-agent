import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { enforceApproval } from "../app/approval.js";
import { createDiffArtifact, readMaybeFile } from "../app/diff.js";
import type { Approval, Artifact, Observation } from "../cli/output.js";
import type { ResolvedExecutionConfig } from "../config/load.js";
import type { LlmTool } from "../llm/openai.js";
import { resolveWorkspacePath } from "./workspace.js";

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
    async run(input) {
      const parsed = applyPatchInputSchema.parse(input);
      const approval = enforceApproval({
        action: parsed,
        config: args.config,
        reason: "file_write",
        requiresApproval: args.config.approvalPolicy !== "auto",
        summary: `Approval required to apply ${parsed.operations.length} patch operation(s).`,
        tool: "apply_patch"
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
  const changedFiles = new Set<string>();
  const artifacts: Artifact[] = [];

  for (const operation of args.operations) {
    const artifact = await applyOperation(args.cwd, operation);
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

  return `Applied patch to ${changedFiles.size} file(s).`;
}

async function applyOperation(cwd: string, operation: PatchOperation): Promise<Artifact> {
  const resolvedPath = resolveWorkspacePath(cwd, operation.path);
  const before = await readMaybeFile(resolvedPath);

  if (operation.type === "replace") {
    if (before === null) {
      throw new Error(`Cannot replace text in missing file \`${operation.path}\`.`);
    }

    if (!before.includes(operation.oldText)) {
      throw new Error(`Old text was not found in \`${operation.path}\`.`);
    }

    const after = before.replace(operation.oldText, operation.newText);
    await writeFile(resolvedPath, after, "utf8");

    return createDiffArtifact({
      after,
      before,
      path: operation.path
    });
  }

  if (operation.type === "create") {
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, operation.content, "utf8");

    return createDiffArtifact({
      after: operation.content,
      before,
      path: operation.path
    });
  }

  if (before === null) {
    throw new Error(`Cannot delete missing file \`${operation.path}\`.`);
  }

  await rm(resolvedPath, { force: true });

  return createDiffArtifact({
    after: null,
    before,
    path: operation.path
  });
}
