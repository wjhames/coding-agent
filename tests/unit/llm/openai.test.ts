import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

  it("runs tool calls before returning the final assistant text", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "write_plan",
                        arguments: JSON.stringify({
                          summary: "Plan summary",
                          items: [
                            {
                              content: "Inspect files",
                              status: "in_progress"
                            }
                          ]
                        })
                      }
                    }
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
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Plan is ready."
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
    const run = vi.fn().mockResolvedValue("{\"ok\":true}");

    await expect(
      client.runTools({
        systemPrompt: "system",
        tools: [
          {
            description: "Write the plan.",
            inputJsonSchema: {
              type: "object"
            },
            inputSchema: z.object({
              items: z.array(
                z.object({
                  content: z.string(),
                  status: z.string()
                })
              ),
              summary: z.string()
            }),
            name: "write_plan",
            run
          }
        ],
        userPrompt: "user"
      })
    ).resolves.toEqual({
      text: "Plan is ready."
    });

    expect(run).toHaveBeenCalledWith({
      items: [
        {
          content: "Inspect files",
          status: "in_progress"
        }
      ],
      summary: "Plan summary"
    });
  });
});
