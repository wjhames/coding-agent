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
        config: {
          defaultProfile: "local",
          profiles: {
            local: {
              apiKey: "secret"
            }
          }
        },
        executionConfig: {
          ...executionConfig,
          profileName: "local",
          model: "gpt-4.1-mini"
        }
      })
    ).toEqual({
      apiKey: "secret",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini"
    });
  });

  it("rejects a missing model", () => {
    expect(() =>
      resolveLlmConfig({
        config: {
          defaultProfile: "local",
          profiles: {
            local: {
              apiKey: "secret"
            }
          }
        },
        executionConfig: resolveExecutionConfig({
          cliOptions: baseOptions(),
          config: null
        })
      })
    ).toThrow(ConfigError);
  });

  it("rejects a missing API key", () => {
    expect(() =>
      resolveLlmConfig({
        config: {
          defaultProfile: "local",
          profiles: {
            local: {}
          }
        },
        executionConfig: {
          ...resolveExecutionConfig({
            cliOptions: baseOptions(),
            config: {
              defaultProfile: "local",
              profiles: {
                local: {}
              }
            }
          }),
          model: "gpt-4.1-mini"
        }
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
