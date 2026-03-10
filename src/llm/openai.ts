import { z } from "zod";

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
      const maxRounds = request.maxRounds ?? 4;

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
          const tool = request.tools.find(
            (candidate) => candidate.name === toolCall.function.name
          );

          if (!tool) {
            throw new LlmError(`Model requested unknown tool \`${toolCall.function.name}\`.`);
          }

          const parsedArgs = parseToolArguments(toolCall.function.arguments);
          const validatedArgs = tool.inputSchema.parse(parsedArgs);
          const toolResult = await tool.run(validatedArgs);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult
          });
        }
      }

      throw new LlmError("Model did not finish after tool execution rounds.");
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
