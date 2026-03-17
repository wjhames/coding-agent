import { z } from "zod";

export const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    arguments: z.string(),
    name: z.string()
  })
});

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
  content?: string | null;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string | undefined;
  tool_calls?: unknown;
}

export class LlmError extends Error {}

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

  return response;
}
