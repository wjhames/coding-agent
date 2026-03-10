import { z } from "zod";
import { ApprovalRequiredError } from "../app/approval.js";

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    arguments: z.string(),
    name: z.string()
  })
});

const chatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z
            .union([
              z.string(),
              z.null(),
              z.array(
                z.object({
                  text: z.string().optional(),
                  type: z.string()
                })
              )
            ])
            .optional(),
          tool_calls: z.array(toolCallSchema).optional()
        })
      })
    )
    .min(1)
});

export interface OpenAICompatibleClientConfig {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  model: string;
}

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
}

export interface LlmTool {
  description: string;
  inputJsonSchema: Record<string, unknown>;
  inputSchema: z.ZodType<unknown>;
  name: string;
  run: (input: unknown) => Promise<string> | string;
}

export interface ToolLoopRequest {
  maxRounds?: number;
  systemPrompt: string;
  tools: LlmTool[];
  userPrompt: string;
}

export interface ToolLoopResult {
  text: string;
}

export class LlmError extends Error {}

const DEFAULT_MAX_TOOL_ROUNDS = 12;
const FINALIZE_TOOL_LOOP_PROMPT = [
  "Stop calling tools.",
  "Using only the completed tool results in this conversation, provide the best final answer now.",
  "Be explicit about what was done, what remains, and any verification status."
].join(" ");

export function createOpenAICompatibleClient(
  config: OpenAICompatibleClientConfig
) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, "");

  return {
    async complete(request: CompletionRequest): Promise<string> {
      const payload = await sendRequest({
        config,
        fetchImpl,
        messages: [
          {
            role: "system",
            content: request.systemPrompt
          },
          {
            role: "user",
            content: request.userPrompt
          }
        ]
      });

      return extractMessageText(payload.choices[0]?.message);
    },

    async runTools(request: ToolLoopRequest): Promise<ToolLoopResult> {
      const messages: Array<Record<string, unknown>> = [
        {
          role: "system",
          content: request.systemPrompt
        },
        {
          role: "user",
          content: request.userPrompt
        }
      ];
      const maxRounds = request.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

      for (let round = 0; round < maxRounds; round += 1) {
        const payload = await sendRequest({
          config,
          fetchImpl,
          messages,
          tools: request.tools
        });
        const message = payload.choices[0]?.message;

        if (!message) {
          throw new LlmError("OpenAI-compatible response did not include a message.");
        }

        const toolCalls = message.tool_calls ?? [];

        if (toolCalls.length === 0) {
          return {
            text: extractMessageText(message)
          };
        }

        messages.push({
          role: "assistant",
          content: normalizeMessageContent(message.content),
          tool_calls: toolCalls
        });

        for (const toolCall of toolCalls) {
          const toolResult = await executeToolCall({
            toolCall,
            tools: request.tools
          });

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult
          });
        }
      }

      const finalPayload = await sendRequest({
        config,
        fetchImpl,
        messages: [
          ...messages,
          {
            role: "user",
            content: FINALIZE_TOOL_LOOP_PROMPT
          }
        ]
      });
      const finalMessage = finalPayload.choices[0]?.message;

      if (!finalMessage) {
        throw new LlmError(
          `Model did not finish after ${maxRounds} tool rounds and did not return a final answer.`
        );
      }

      const finalText = normalizeMessageContent(finalMessage.content);

      if (finalText.length > 0) {
        return {
          text: finalText
        };
      }

      throw new LlmError(
        `Model did not finish after ${maxRounds} tool rounds. Increase --max-steps or use a model with stronger tool-use stopping behavior.`
      );
    }
  };
}

async function sendRequest(args: {
  config: OpenAICompatibleClientConfig;
  fetchImpl: typeof fetch;
  messages: Array<Record<string, unknown>>;
  tools?: LlmTool[];
}) {
  const response = await args.fetchImpl(
    `${args.config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: args.config.model,
        messages: args.messages,
        ...(args.tools
          ? {
              tool_choice: "auto",
              tools: args.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputJsonSchema
                }
              }))
            }
          : {})
      })
    }
  );

  if (!response.ok) {
    throw new LlmError(
      `OpenAI-compatible request failed with status ${response.status}.`
    );
  }

  return chatCompletionResponseSchema.parse(await response.json());
}

function extractMessageText(
  message: z.infer<typeof chatCompletionResponseSchema>["choices"][number]["message"] | undefined
): string {
  if (!message) {
    throw new LlmError("OpenAI-compatible response did not include a message.");
  }

  const content = normalizeMessageContent(message.content);

  if (content.length === 0) {
    throw new LlmError("OpenAI-compatible response did not include text content.");
  }

  return content;
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (part): part is { text?: string; type: string } =>
        typeof part === "object" && part !== null && "type" in part
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmError("Model returned invalid tool arguments.");
  }
}

async function executeToolCall(args: {
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
