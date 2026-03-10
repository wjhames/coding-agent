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
  onTextDelta?: ((delta: string) => void) | undefined;
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
        const message = await sendToolLoopMessage({
          config,
          fetchImpl,
          messages,
          onTextDelta: request.onTextDelta,
          tools: request.tools
        });

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

      const finalMessage = await sendToolLoopMessage({
        config,
        fetchImpl,
        messages: [
          ...messages,
          {
            role: "user",
            content: FINALIZE_TOOL_LOOP_PROMPT
          }
        ],
        onTextDelta: request.onTextDelta
      });

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

async function sendToolLoopMessage(args: {
  config: OpenAICompatibleClientConfig;
  fetchImpl: typeof fetch;
  messages: Array<Record<string, unknown>>;
  onTextDelta?: ((delta: string) => void) | undefined;
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
        stream: true,
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

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const payload = chatCompletionResponseSchema.parse(await response.json());
    return payload.choices[0]?.message;
  }

  return readStreamingMessage(response.body, args.onTextDelta);
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

async function readStreamingMessage(
  body: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void
): Promise<z.infer<typeof chatCompletionResponseSchema>["choices"][number]["message"]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = new Map<number, z.infer<typeof toolCallSchema>>();

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleSseFrame(frame, {
        onTextDelta,
        onToolCallDelta(index, delta) {
          const current =
            toolCalls.get(index) ??
            ({
              id: delta.id ?? `tool-${index}`,
              type: "function",
              function: {
                arguments: "",
                name: ""
              }
            } satisfies z.infer<typeof toolCallSchema>);

          toolCalls.set(index, {
            id: delta.id ?? current.id,
            type: "function",
            function: {
              arguments: `${current.function.arguments}${delta.function?.arguments ?? ""}`,
              name: delta.function?.name ?? current.function.name
            }
          });
        },
        pushContent(delta) {
          content += delta;
        }
      });
      boundary = buffer.indexOf("\n\n");
    }
  }

  return {
    ...(content.length > 0 ? { content } : { content: null }),
    ...(toolCalls.size > 0
      ? {
          tool_calls: [...toolCalls.entries()]
            .sort((left, right) => left[0] - right[0])
            .map((entry) => entry[1])
        }
      : {})
  };
}

function handleSseFrame(
  frame: string,
  handlers: {
    onTextDelta?: ((delta: string) => void) | undefined;
    onToolCallDelta: (
      index: number,
      delta: {
        function?: {
          arguments?: string | undefined;
          name?: string | undefined;
        } | undefined;
        id?: string | undefined;
      }
    ) => void;
    pushContent: (delta: string) => void;
  }
): void {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);

  for (const line of dataLines) {
    if (line === "[DONE]") {
      continue;
    }

    const payload = JSON.parse(line) as {
      choices?: Array<{
        delta?: {
          content?: string | Array<{ text?: string; type?: string }> | null;
          tool_calls?: Array<{
            function?: {
              arguments?: string;
              name?: string;
            };
            id?: string;
            index?: number;
          }>;
        };
      }>;
    };

    for (const choice of payload.choices ?? []) {
      const delta = choice.delta;
      if (!delta) {
        continue;
      }

      const contentDelta = normalizeStreamingContent(delta.content);
      if (contentDelta.length > 0) {
        handlers.pushContent(contentDelta);
        handlers.onTextDelta?.(contentDelta);
      }

      for (const toolCall of delta.tool_calls ?? []) {
        handlers.onToolCallDelta(toolCall.index ?? 0, {
          ...(toolCall.function ? { function: toolCall.function } : {}),
          ...(toolCall.id ? { id: toolCall.id } : {})
        });
      }
    }
  }
}

function normalizeStreamingContent(
  content: string | Array<{ text?: string; type?: string }> | null | undefined
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
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
