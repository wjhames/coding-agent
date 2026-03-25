import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createOpenAICompatibleClient,
  LlmError
} from "../../../src/llm/openai-client.js";

describe("createOpenAICompatibleClient", () => {
  it("streams assistant deltas from an event-stream response", async () => {
    const chunks = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n",
      "data: [DONE]\n\n"
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
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
    const deltas: string[] = [];

    await expect(
      client.runTools({
        messages: [
          {
            content: "system",
            role: "system"
          },
          {
            content: "user",
            role: "user"
          }
        ],
        onTextDelta(delta) {
          deltas.push(delta);
        },
        tools: []
      })
    ).resolves.toEqual({
      text: "Hello world"
    });

    expect(deltas).toEqual(["Hello ", "world"]);
  });

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

  it("passes an abort signal to provider requests when a timeout is configured", async () => {
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
      baseUrl: "http://localhost:1234/v1",
      fetchImpl,
      model: "gpt-4.1-mini",
      timeoutMs: 5
    });

    await client.complete({
      systemPrompt: "system",
      userPrompt: "user"
    });

    const options = fetchImpl.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(options?.signal).toBeDefined();
    expect(typeof options?.signal?.aborted).toBe("boolean");
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

  it("raises a typed error with provider details on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              "messages with role \"tool\" must be a response to a preceeding message with \"tool_calls\"."
          }
        }),
        {
          status: 400,
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

    const error = await client
      .complete({
        systemPrompt: "system",
        userPrompt: "user"
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({
      message: expect.stringContaining("messages with role \"tool\"")
    });
  });

  it("rejects orphan tool messages before making a provider request", async () => {
    const fetchImpl = vi.fn();
    const client = createOpenAICompatibleClient({
      apiKey: "secret",
      baseUrl: "http://localhost:1234/v1",
      fetchImpl,
      model: "gpt-4.1-mini"
    });

    await expect(
      client.runTools({
        messages: [
          {
            content: "system",
            role: "system"
          },
          {
            content: "{\"ok\":true}",
            role: "tool",
            tool_call_id: "call-1"
          }
        ],
        tools: []
      })
    ).rejects.toThrow(/does not immediately follow its assistant tool_calls block/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends valid assistant and tool replay transcripts to the provider", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Replay transcript accepted."
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
      client.runTools({
        messages: [
          {
            content: "system",
            role: "system"
          },
          {
            content: "",
            role: "assistant",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  arguments: "{\"path\":\"src/config.ts\"}",
                  name: "read_file"
                }
              }
            ]
          },
          {
            content: "{\"ok\":true}",
            role: "tool",
            tool_call_id: "call-1"
          }
        ],
        tools: []
      })
    ).resolves.toEqual({
      text: "Replay transcript accepted."
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
        messages: [
          {
            content: "system",
            role: "system"
          },
          {
            content: "user",
            role: "user"
          }
        ],
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
        ]
      })
    ).resolves.toEqual({
      text: "Plan is ready."
    });

    expect(run).toHaveBeenCalledWith(
      {
        items: [
          {
            content: "Inspect files",
            status: "in_progress"
          }
        ],
        summary: "Plan summary"
      },
      {
        toolCallId: "call-1"
      }
    );
  });

  it("forces a final answer after hitting the tool round cap", async () => {
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
                  content: "Final answer after forced stop."
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
      client.runTools({
        maxRounds: 1,
        messages: [
          {
            content: "system",
            role: "system"
          },
          {
            content: "user",
            role: "user"
          }
        ],
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
            run: vi.fn().mockResolvedValue("{\"ok\":true}")
          }
        ]
      })
    ).resolves.toEqual({
      text: "Final answer after forced stop."
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const lastCall = fetchImpl.mock.calls[1];
    expect(lastCall?.[1]).toEqual(
      expect.objectContaining({
        body: expect.stringContaining("Stop calling tools.")
      })
    );
  });

  it("returns tool errors to the model instead of aborting the loop", async () => {
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
                        name: "read_file",
                        arguments: JSON.stringify({
                          path: "/tmp/not-a-file"
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
                  content: "Recovered after tool error."
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
      client.runTools({
        messages: [
          {
            content: "system",
            role: "system"
          },
          {
            content: "user",
            role: "user"
          }
        ],
        tools: [
          {
            description: "Read a file.",
            inputJsonSchema: { type: "object" },
            inputSchema: z.object({
              path: z.string()
            }),
            name: "read_file",
            run: vi.fn().mockRejectedValue(new Error("Requested path is not a file."))
          }
        ]
      })
    ).resolves.toEqual({
      text: "Recovered after tool error."
    });

    const secondCall = fetchImpl.mock.calls[1];
    expect(typeof secondCall?.[1]?.body).toBe("string");
    const requestBody = JSON.parse(String(secondCall?.[1]?.body)) as {
      messages: Array<{ content?: string; role: string }>;
    };
    expect(requestBody.messages.at(-1)).toEqual({
      content:
        "{\"ok\":false,\"error\":\"tool_error\",\"message\":\"Requested path is not a file.\"}",
      role: "tool",
      tool_call_id: "call-1"
    });
  });

  it("reconstructs streamed tool calls across chunk boundaries", async () => {
    const chunks = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"src/\"}}]}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"config.ts\\\"}\"}}]}}]}\n\n",
      "data: [DONE]\n\n"
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(new TextEncoder().encode(chunk));
              }
              controller.close();
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream"
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
                  content: "Done."
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
        messages: [
          {
            content: "system",
            role: "system"
          },
          {
            content: "user",
            role: "user"
          }
        ],
        tools: [
          {
            description: "Read a file.",
            inputJsonSchema: { type: "object" },
            inputSchema: z.object({ path: z.string() }),
            name: "read_file",
            run
          }
        ]
      })
    ).resolves.toEqual({ text: "Done." });

    expect(run).toHaveBeenCalledWith(
      { path: "src/config.ts" },
      {
        toolCallId: "call-1"
      }
    );

    const secondCall = fetchImpl.mock.calls[1];
    expect(typeof secondCall?.[1]?.body).toBe("string");
    const requestBody = JSON.parse(String(secondCall?.[1]?.body)) as {
      messages: Array<{
        content?: string;
        role: string;
        tool_call_id?: string;
        tool_calls?: Array<{
          id: string;
          type: "function";
          function: {
            arguments: string;
            name: string;
          };
        }>;
      }>;
    };

    expect(requestBody.messages.at(-2)).toEqual({
      content: "",
      role: "assistant",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            arguments: "{\"path\":\"src/config.ts\"}",
            name: "read_file"
          }
        }
      ]
    });
    expect(requestBody.messages.at(-1)).toEqual({
      content: "{\"ok\":true}",
      role: "tool",
      tool_call_id: "call-1"
    });
  });
});
