import { describe, expect, it } from "vitest";
import {
  ConfigError,
  resolveExecutionConfig,
  resolveLlmConfig
} from "../../src/config/load.js";
import type { ParsedOptions } from "../../src/cli/parse.js";

describe("resolveLlmConfig", () => {
  it("uses default OpenAI values when config does not override them", () => {
    const executionConfig = resolveExecutionConfig({
      cliOptions: baseOptions(),
      config: null
    });

    expect(
      resolveLlmConfig({
        executionConfig: {
          ...executionConfig,
          model: "gpt-4.1-mini"
        },
        env: {
          OPENAI_API_KEY: "secret"
        }
      })
    ).toEqual({
      apiKey: "secret",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini"
    });
  });

  it("rejects a missing model", () => {
    expect(() =>
      resolveLlmConfig({
        executionConfig: resolveExecutionConfig({
          cliOptions: baseOptions(),
          config: null
        }),
        env: {
          OPENAI_API_KEY: "secret"
        }
      })
    ).toThrow(ConfigError);
  });

  it("rejects a missing API key env", () => {
    expect(() =>
      resolveLlmConfig({
        executionConfig: {
          ...resolveExecutionConfig({
            cliOptions: baseOptions(),
            config: null
          }),
          model: "gpt-4.1-mini"
        },
        env: {}
      })
    ).toThrow(ConfigError);
  });
});

function baseOptions(): ParsedOptions {
  return {
    approvalPolicy: undefined,
    baseUrl: undefined,
    cwd: undefined,
    help: false,
    json: false,
    maxSteps: undefined,
    model: undefined,
    output: undefined,
    profile: undefined,
    quiet: false,
    timeout: undefined,
    verbose: false
  };
}
