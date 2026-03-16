import { z } from "zod";
import type { Observation } from "../runtime/contracts.js";
import type { LlmTool } from "../llm/openai-client.js";
import { walkWorkspaceFiles } from "./workspace.js";

const listFilesInputSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
  path: z.string().min(1).optional()
});

export function createListFilesTool(args: {
  cwd: string;
  observe: (observation: Observation) => void;
}): LlmTool {
  return {
    description: "List files in the workspace or under a workspace subdirectory.",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Optional workspace-relative directory or file prefix."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of file paths to return."
        }
      }
    },
    inputSchema: listFilesInputSchema,
    name: "list_files",
    async run(input) {
      const parsed = listFilesInputSchema.parse(input);
      const files = await walkWorkspaceFiles({
        cwd: args.cwd,
        limit: parsed.limit ?? 50,
        path: parsed.path
      });
      const excerpt = files.join("\n");

      args.observe({
        excerpt,
        path: parsed.path,
        summary: `Listed ${files.length} file(s).`,
        tool: "list_files"
      });

      return JSON.stringify({
        entries: files,
        ok: true,
        path: parsed.path ?? "."
      });
    }
  };
}
