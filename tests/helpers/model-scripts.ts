import type { MockResponse } from "./mock-llm.js";

export function contaminatedSummaryResponse(content: string): MockResponse {
  return {
    body: {
      choices: [
        {
          message: {
            content: `${content}\n<tool_call>\n<function=run_shell>\n{\"command\":\"npm test\"}\n</tool_call>`
          }
        }
      ]
    }
  };
}

export function incompleteSummaryResponse(content: string): MockResponse {
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
