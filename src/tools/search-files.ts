import { z } from "zod";
import type { Observation } from "../cli/output.js";
import type { LlmTool } from "../llm/openai.js";
import { readWorkspaceTextFile, walkWorkspaceFiles } from "./workspace.js";

const searchFilesInputSchema = z.object({
  limit: z.number().int().positive().max(50).optional(),
  path: z.string().min(1).optional(),
  query: z.string().min(1)
});

export function createSearchFilesTool(args: {
  cwd: string;
  observe: (observation: Observation) => void;
}): LlmTool {
  return {
    description: "Search workspace files for a literal text query.",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Literal text to search for."
        },
        path: {
          type: "string",
          description: "Optional workspace-relative directory to search under."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of matches to return."
        }
      },
      required: ["query"]
    },
    inputSchema: searchFilesInputSchema,
    name: "search_files",
    async run(input) {
      const parsed = searchFilesInputSchema.parse(input);
      const matches = await searchFiles({
        cwd: args.cwd,
        limit: parsed.limit ?? 20,
        path: parsed.path,
        query: parsed.query
      });
      const excerpt = matches.join("\n");

      args.observe({
        excerpt,
        path: parsed.path,
        query: parsed.query,
        summary: `Found ${matches.length} match(es) for "${parsed.query}".`,
        tool: "search_files"
      });

      return excerpt.length > 0 ? excerpt : "No matches found.";
    }
  };
}

async function searchFiles(args: {
  cwd: string;
  limit: number;
  path: string | undefined;
  query: string;
}): Promise<string[]> {
  const files = await walkWorkspaceFiles({
    cwd: args.cwd,
    limit: 200,
    path: args.path
  });
  const matches: string[] = [];

  for (const file of files) {
    if (matches.length >= args.limit) {
      break;
    }

    const contents = await readWorkspaceTextFile({
      cwd: args.cwd,
      maxBytes: 32_000,
      path: file
    }).catch(() => null);

    if (contents === null) {
      continue;
    }

    const lines = contents.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= args.limit) {
        break;
      }

      if (lines[index]?.includes(args.query)) {
        matches.push(`${file}:${index + 1}: ${lines[index]}`);
      }
    }
  }

  return matches;
}
