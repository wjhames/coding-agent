import { z } from "zod";

export const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    arguments: z.string(),
    name: z.string()
  })
});

export type OpenAICompatibleToolCall = z.infer<typeof toolCallSchema>;

export const chatCompletionResponseSchema = z.object({
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

export interface OpenAICompatibleMessage {
  content?: string | undefined;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string | undefined;
  tool_calls?: OpenAICompatibleToolCall[] | undefined;
}

export class LlmError extends Error {}

export function validateMessages(messages: OpenAICompatibleMessage[]): void {
  let pendingToolCallIds: Set<string> | null = null;
  let fulfilledToolCallIds = new Set<string>();

  for (const [index, message] of messages.entries()) {
    if (message.role !== "tool" && message.tool_call_id) {
      throw new LlmError(
        `Invalid outbound message transcript: only tool messages may include tool_call_id. ${summarizeTranscript(messages)}`
      );
    }

    if (message.role !== "assistant" && message.tool_calls !== undefined) {
      throw new LlmError(
        `Invalid outbound message transcript: only assistant messages may include tool_calls. ${summarizeTranscript(messages)}`
      );
    }

    if (message.role === "tool") {
      if (typeof message.content !== "string") {
        throw new LlmError(
          `Invalid outbound message transcript: tool message at index ${index} is missing string content. ${summarizeTranscript(messages)}`
        );
      }

      if (!message.tool_call_id) {
        throw new LlmError(
          `Invalid outbound message transcript: tool message at index ${index} is missing tool_call_id. ${summarizeTranscript(messages)}`
        );
      }

      if (!pendingToolCallIds || !pendingToolCallIds.has(message.tool_call_id)) {
        throw new LlmError(
          `Invalid outbound message transcript: tool message at index ${index} does not immediately follow its assistant tool_calls block. ${summarizeTranscript(messages)}`
        );
      }

      if (fulfilledToolCallIds.has(message.tool_call_id)) {
        throw new LlmError(
          `Invalid outbound message transcript: duplicate tool result for ${message.tool_call_id}. ${summarizeTranscript(messages)}`
        );
      }

      fulfilledToolCallIds.add(message.tool_call_id);
      continue;
    }

    if (pendingToolCallIds && fulfilledToolCallIds.size !== pendingToolCallIds.size) {
      throw new LlmError(
        `Invalid outbound message transcript: assistant tool_calls block was not fully satisfied before the next ${message.role} message. ${summarizeTranscript(messages)}`
      );
    }

    pendingToolCallIds = null;
    fulfilledToolCallIds = new Set<string>();

    if (message.role !== "assistant" || message.tool_calls === undefined) {
      continue;
    }

    if (typeof message.content !== "string") {
      throw new LlmError(
        `Invalid outbound message transcript: assistant tool_calls message at index ${index} must include string content. ${summarizeTranscript(messages)}`
      );
    }

    if (message.tool_calls.length === 0) {
      throw new LlmError(
        `Invalid outbound message transcript: assistant tool_calls message at index ${index} has an empty tool_calls array. ${summarizeTranscript(messages)}`
      );
    }

    const toolCallIds = message.tool_calls.map((toolCall) => toolCall.id);
    const uniqueToolCallIds = new Set(toolCallIds);

    if (toolCallIds.some((id) => id.length === 0) || uniqueToolCallIds.size !== toolCallIds.length) {
      throw new LlmError(
        `Invalid outbound message transcript: assistant tool_calls message at index ${index} has missing or duplicate tool call ids. ${summarizeTranscript(messages)}`
      );
    }

    pendingToolCallIds = uniqueToolCallIds;
  }

  if (pendingToolCallIds && fulfilledToolCallIds.size !== pendingToolCallIds.size) {
    throw new LlmError(
      `Invalid outbound message transcript: assistant tool_calls block at the end of the request is missing tool results. ${summarizeTranscript(messages)}`
    );
  }
}

export async function sendRequest(args: {
  config: OpenAICompatibleClientConfig;
  fetchImpl: typeof fetch;
  messages: OpenAICompatibleMessage[];
  tools?: Array<{
    description: string;
    inputJsonSchema: Record<string, unknown>;
    name: string;
  }>;
}) {
  validateMessages(args.messages);

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
    throw new LlmError(await buildTransportErrorMessage(response));
  }

  return chatCompletionResponseSchema.parse(await response.json());
}

export async function sendStreamingRequest(args: {
  config: OpenAICompatibleClientConfig;
  fetchImpl: typeof fetch;
  messages: OpenAICompatibleMessage[];
  tools?: Array<{
    description: string;
    inputJsonSchema: Record<string, unknown>;
    name: string;
  }>;
}) {
  validateMessages(args.messages);

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
    throw new LlmError(await buildTransportErrorMessage(response));
  }

  return response;
}

function summarizeTranscript(messages: OpenAICompatibleMessage[]): string {
  const shape = messages.map((message, index) => {
    if (message.role === "assistant" && message.tool_calls) {
      return `${index}:assistant[tool_calls=${message.tool_calls.map((toolCall) => toolCall.id).join(",")}]`;
    }

    if (message.role === "tool") {
      return `${index}:tool[tool_call_id=${message.tool_call_id ?? "missing"}]`;
    }

    return `${index}:${message.role}`;
  });

  return `Transcript: ${shape.join(" -> ")}`;
}

async function buildTransportErrorMessage(response: Response): Promise<string> {
  const prefix = `OpenAI-compatible request failed with status ${response.status}.`;

  try {
    const raw = await response.text();

    if (!raw.trim()) {
      return prefix;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = JSON.parse(raw) as {
        error?: {
          message?: string;
        };
        message?: string;
      };
      const detail = parsed.error?.message ?? parsed.message ?? raw.trim();
      return `${prefix} ${detail}`;
    }

    return `${prefix} ${raw.trim()}`;
  } catch {
    return prefix;
  }
}
