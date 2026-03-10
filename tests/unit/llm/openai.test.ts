import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleClient,
  LlmError
} from "../../../src/llm/openai.js";

describe("createOpenAICompatibleClient", () => {
  it("sends a chat completion request and returns string content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "plan the work"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const client = createOpenAICompatibleClient({
      apiKey: "secret",
      baseUrl: "http://localhost:1234/v1/",
      fetchImpl,
      model: "gpt-4.1-mini"
    });

    await expect(
      client.complete({
        systemPrompt: "system",
        userPrompt: "user"
      })
    ).resolves.toBe("plan the work");

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:1234/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json"
        }
      })
    );
  });

  it("joins text parts when the API returns content blocks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "first " },
                  { type: "text", text: "second" }
                ]
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const client = createOpenAICompatibleClient({
      apiKey: "secret",
      baseUrl: "http://localhost:1234/v1",
      fetchImpl,
      model: "gpt-4.1-mini"
    });

    await expect(
      client.complete({
        systemPrompt: "system",
        userPrompt: "user"
      })
    ).resolves.toBe("first second");
  });

  it("raises a typed error on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("upstream error", { status: 500 })
    );

    const client = createOpenAICompatibleClient({
      apiKey: "secret",
      baseUrl: "http://localhost:1234/v1",
      fetchImpl,
      model: "gpt-4.1-mini"
    });

    await expect(
      client.complete({
        systemPrompt: "system",
        userPrompt: "user"
      })
    ).rejects.toBeInstanceOf(LlmError);
  });
});
