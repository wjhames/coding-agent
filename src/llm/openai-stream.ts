import { z } from "zod";
import { chatCompletionResponseSchema, LlmError, toolCallSchema } from "./openai-transport.js";

export function normalizeMessageContent(content: unknown): string {
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

export function extractMessageText(
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

export async function readStreamingMessage(
  body: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void
): Promise<z.infer<typeof chatCompletionResponseSchema>["choices"][number]["message"]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let semanticDone = false;
  const toolCalls = new Map<number, z.infer<typeof toolCallSchema>>();

  try {
    while (!semanticDone) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        semanticDone = handleSseFrame(frame, {
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
        if (semanticDone) {
          break;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    if (semanticDone) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
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
): boolean {
  const dataLines = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);

  for (const line of dataLines) {
    if (line === "[DONE]") {
      return true;
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

  return false;
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
