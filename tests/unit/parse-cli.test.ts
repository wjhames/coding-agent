import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs } from "../../src/cli/parse.js";

describe("parseCliArgs", () => {
  it("parses the root interactive command", () => {
    expect(parseCliArgs(["--help"])).toEqual({
      command: "interactive",
      options: {
        approvalPolicy: undefined,
        baseUrl: undefined,
        cwd: undefined,
        help: true,
        json: false,
        maxSteps: undefined,
        model: undefined,
        output: undefined,
        profile: undefined,
        quiet: false,
        timeout: undefined,
        verbose: false
      },
      prompt: undefined,
      sessionId: undefined
    });
  });

  it("parses exec flags and prompt", () => {
    expect(
      parseCliArgs([
        "exec",
        "fix",
        "the",
        "build",
        "--json",
        "--max-steps",
        "4",
        "--base-url",
        "http://localhost:1234/v1"
      ])
    ).toEqual({
      command: "exec",
      options: {
        approvalPolicy: undefined,
        baseUrl: "http://localhost:1234/v1",
        cwd: undefined,
        help: false,
        json: true,
        maxSteps: 4,
        model: undefined,
        output: undefined,
        profile: undefined,
        quiet: false,
        timeout: undefined,
        verbose: false
      },
      prompt: "fix the build",
      sessionId: undefined
    });
  });

  it("parses resume with a session id", () => {
    expect(parseCliArgs(["resume", "abc123"])).toEqual({
      command: "resume",
      options: {
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
      },
      prompt: undefined,
      sessionId: "abc123"
    });
  });

  it("rejects invalid max steps", () => {
    expect(() => parseCliArgs(["exec", "--max-steps", "0"])).toThrow(
      CliUsageError
    );
  });

  it("rejects extra resume positionals", () => {
    expect(() => parseCliArgs(["resume", "one", "two"])).toThrow(CliUsageError);
  });
});
