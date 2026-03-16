import { z } from "zod";
import { ApprovalRequiredError } from "../app/approval.js";
import { LlmError, toolCallSchema } from "./openai-transport.js";
import { normalizeMessageContent } from "./openai-stream.js";

export interface LlmTool {
  description: string;
  inputJsonSchema: Record<string, unknown>;
  inputSchema: z.ZodType<unknown>;
  name: string;
  run: (input: unknown) => Promise<string> | string;
}

export interface ToolLoopRequest {
  maxRounds?: number;
  onTextDelta?: ((delta: string) => void) | undefined;
  systemPrompt: string;
  tools: LlmTool[];
  userPrompt: string;
}

export interface ToolLoopResult {
  text: string;
}

export const DEFAULT_MAX_TOOL_ROUNDS = 12;
export const FINALIZE_TOOL_LOOP_PROMPT = [
  "Stop calling tools.",
  "Using only the completed tool results in this conversation, provide the best final answer now.",
  "Be explicit about what was done, what remains, and any verification status."
].join(" ");

export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmError("Model returned invalid tool arguments.");
  }
}

export async function executeToolCall(args: {
  toolCall: z.infer<typeof toolCallSchema>;
  tools: LlmTool[];
}): Promise<string> {
  const tool = args.tools.find((candidate) => candidate.name === args.toolCall.function.name);

  if (!tool) {
    return JSON.stringify({
      ok: false,
      error: "unknown_tool",
      message: `Unknown tool: ${args.toolCall.function.name}`
    });
  }

  try {
    const parsedArgs = parseToolArguments(args.toolCall.function.arguments);
    return await tool.run(parsedArgs);
  } catch (error) {
    if (error instanceof ApprovalRequiredError) {
      throw error;
    }

    return JSON.stringify({
      ok: false,
      error: "tool_error",
      message: error instanceof Error ? error.message : "Unknown tool execution failure."
    });
  }
}

export function assistantMessageFromToolLoop(args: {
  content: unknown;
  toolCalls?: z.infer<typeof toolCallSchema>[];
}): Array<Record<string, unknown>> {
  return [
    {
      role: "assistant",
      content: normalizeMessageContent(args.content),
      ...(args.toolCalls ? { tool_calls: args.toolCalls } : {})
    }
  ];
}
