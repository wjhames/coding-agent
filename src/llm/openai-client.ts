import { z } from "zod";
import {
  chatCompletionResponseSchema,
  LlmError,
  sendRequest,
  sendStreamingRequest,
  type OpenAICompatibleClientConfig
} from "./openai-transport.js";
import {
  extractMessageText,
  normalizeMessageContent,
  readStreamingMessage
} from "./openai-stream.js";
import {
  assistantMessageFromToolLoop,
  DEFAULT_MAX_TOOL_ROUNDS,
  executeToolCall,
  FINALIZE_TOOL_LOOP_PROMPT,
  type LlmTool,
  type ToolLoopRequest,
  type ToolLoopResult
} from "./tool-loop.js";

export interface CompletionRequest {
  systemPrompt: string;
  userPrompt: string;
}

export type { LlmTool, OpenAICompatibleClientConfig, ToolLoopRequest, ToolLoopResult };
export { LlmError };

export function createOpenAICompatibleClient(
  config: OpenAICompatibleClientConfig
) {
  const fetchImpl = config.fetchImpl ?? fetch;

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
        const response = await sendStreamingRequest({
          config,
          fetchImpl,
          messages,
          tools: request.tools
        });

        const contentType = response.headers.get("content-type") ?? "";
        const message = !contentType.includes("text/event-stream") || !response.body
          ? chatCompletionResponseSchema.parse(await response.json()).choices[0]?.message
          : await readStreamingMessage(response.body, request.onTextDelta);

        if (!message) {
          throw new LlmError("OpenAI-compatible response did not include a message.");
        }

        const toolCalls = message.tool_calls ?? [];

        if (toolCalls.length === 0) {
          return {
            text: extractMessageText(message)
          };
        }

        messages.push(...assistantMessageFromToolLoop({
          content: message.content,
          toolCalls
        }));

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

      const finalResponse = await sendStreamingRequest({
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
      const finalContentType = finalResponse.headers.get("content-type") ?? "";
      const finalMessage =
        !finalContentType.includes("text/event-stream") || !finalResponse.body
          ? chatCompletionResponseSchema.parse(await finalResponse.json()).choices[0]?.message
          : await readStreamingMessage(finalResponse.body, request.onTextDelta);

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
