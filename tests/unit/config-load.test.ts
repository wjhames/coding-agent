import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  resolveExecutionConfig
} from "../../src/config/load.js";
import type { ParsedOptions } from "../../src/cli/parse.js";

const tempDirs: string[] = [];

describe("config loading", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("returns null when the config file does not exist", async () => {
    const cwd = await makeTempDir();

    await expect(loadConfig(cwd)).resolves.toBeNull();
  });

  it("loads a valid config file", async () => {
    const cwd = await makeTempDir();

    await writeFile(
      join(cwd, ".coding-agent.json"),
      JSON.stringify({
        defaultProfile: "local",
        profiles: {
          local: {
            apiKeyEnv: "OPENAI_API_KEY",
            approvalPolicy: "prompt",
            baseUrl: "http://localhost:1234/v1",
            maxSteps: 8,
            model: "gpt-4.1-mini"
          }
        }
      }),
      "utf8"
    );

    await expect(loadConfig(cwd)).resolves.toEqual({
      defaultProfile: "local",
      profiles: {
        local: {
          apiKeyEnv: "OPENAI_API_KEY",
          approvalPolicy: "prompt",
          baseUrl: "http://localhost:1234/v1",
          maxSteps: 8,
          model: "gpt-4.1-mini"
        }
      }
    });
  });

  it("rejects invalid config", async () => {
    const cwd = await makeTempDir();
    await writeFile(join(cwd, ".coding-agent.json"), "{\"profiles\":[]}", "utf8");

    await expect(loadConfig(cwd)).rejects.toBeInstanceOf(ConfigError);
  });

  it("resolves cli overrides before profile values", () => {
    const cliOptions: ParsedOptions = {
      approvalPolicy: "auto",
      baseUrl: "http://localhost:5678/v1",
      cwd: undefined,
      help: false,
      json: false,
      maxSteps: 4,
      model: "gpt-4.1",
      output: undefined,
      profile: "local",
      quiet: false,
      timeout: "5m",
      verbose: false
    };

    expect(
      resolveExecutionConfig({
        cliOptions,
        config: {
          defaultProfile: "local",
          profiles: {
            local: {
              apiKeyEnv: "OPENAI_API_KEY",
              approvalPolicy: "prompt",
              baseUrl: "http://localhost:1234/v1",
              maxSteps: 8,
              model: "gpt-4.1-mini",
              networkEgress: false,
              timeout: "10m"
            }
          }
        }
      })
    ).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      approvalPolicy: "auto",
      baseUrl: "http://localhost:5678/v1",
      maxSteps: 4,
      model: "gpt-4.1",
      networkEgress: false,
      profileName: "local",
      timeout: "5m"
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "coding-agent-config-"));
  tempDirs.push(dir);
  return dir;
}
