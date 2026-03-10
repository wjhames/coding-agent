import { z } from "zod";
import type { Observation } from "../cli/output.js";
import type { LlmTool } from "../llm/openai.js";
import { readWorkspaceTextFile } from "./workspace.js";

const readFileInputSchema = z.object({
  maxLines: z.number().int().positive().max(200).optional(),
  path: z.string().min(1),
  startLine: z.number().int().positive().optional()
});

export function createReadFileTool(args: {
  cwd: string;
  observe: (observation: Observation) => void;
}): LlmTool {
  return {
    description: "Read a workspace file with bounded line output.",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path."
        },
        startLine: {
          type: "integer",
          minimum: 1,
          description: "1-based start line."
        },
        maxLines: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of lines to return."
        }
      },
      required: ["path"]
    },
    inputSchema: readFileInputSchema,
    name: "read_file",
    async run(input) {
      const parsed = readFileInputSchema.parse(input);
      const contents = await readWorkspaceTextFile({
        cwd: args.cwd,
        maxBytes: 32_000,
        path: parsed.path
      });
      const lines = contents.split("\n");
      const startIndex = (parsed.startLine ?? 1) - 1;
      const maxLines = parsed.maxLines ?? 80;
      const selectedLines = lines.slice(startIndex, startIndex + maxLines);
      const excerpt = selectedLines
        .map((line, index) => `${startIndex + index + 1}: ${line}`)
        .join("\n");

      args.observe({
        excerpt,
        path: parsed.path,
        summary: `Read ${parsed.path} lines ${startIndex + 1}-${startIndex + selectedLines.length}.`,
        tool: "read_file"
      });

      return excerpt.length > 0 ? excerpt : "No content found.";
    }
  };
}
