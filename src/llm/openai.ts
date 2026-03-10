import { z } from "zod";

const chatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.union([
            z.string(),
            z.array(
              z.object({
                text: z.string().optional(),
                type: z.string()
              })
            )
          ])
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

export class LlmError extends Error {}

export function createOpenAICompatibleClient(
  config: OpenAICompatibleClientConfig
) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, "");

  return {
    async complete(request: CompletionRequest): Promise<string> {
      const response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${config.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
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
        })
      });

      if (!response.ok) {
        throw new LlmError(
          `OpenAI-compatible request failed with status ${response.status}.`
        );
      }

      const payload = chatCompletionResponseSchema.parse(await response.json());
      const firstContent = payload.choices[0]?.message.content;

      if (firstContent === undefined) {
        throw new LlmError("OpenAI-compatible response did not include a message.");
      }

      if (typeof firstContent === "string") {
        return firstContent.trim();
      }

      const text = firstContent
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim();

      if (text.length === 0) {
        throw new LlmError("OpenAI-compatible response did not include text content.");
      }

      return text;
    }
  };
}
