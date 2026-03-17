import { createServer, type Server } from "node:http";
import { once } from "node:events";

const servers = new Set<Server>();

export interface MockResponse {
  body: unknown;
  status?: number;
}

export async function createMockLlmServer(
  responses: MockResponse[]
): Promise<{ baseUrl: string }> {
  const server = createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      !(request.url === "/chat/completions" || request.url === "/v1/chat/completions")
    ) {
      response.writeHead(404).end();
      return;
    }

    for await (const _chunk of request) {
      // drain request body
    }

    const next = responses.shift();
    if (!next) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "No mocked responses remaining." }));
      return;
    }

    response.writeHead(next.status ?? 200, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify(next.body));
  });

  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock server did not expose a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`
  };
}

export async function cleanupMockLlmServers(): Promise<void> {
  await Promise.all([...servers].map((server) => closeServer(server)));
  servers.clear();
}

export function toolCallResponse(name: string, argumentsObject: Record<string, unknown>): MockResponse {
  return {
    body: {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(argumentsObject)
                }
              }
            ]
          }
        }
      ]
    }
  };
}

export function finalResponse(content: string): MockResponse {
  return {
    body: {
      choices: [
        {
          message: {
            content
          }
        }
      ]
    }
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}
