import { describe, expect, it } from "vitest";
import { planVerificationCommands } from "../../src/app/verification.js";

describe("planVerificationCommands", () => {
  it("does not infer verification for read-only inspection from incidental summary mentions", () => {
    expect(
      planVerificationCommands({
        assistantSummary: "This repository has build and test scripts and multiple tests under tests/ui.",
        changedFiles: [],
        prompt: "Inspect this repository and summarize the current implementation status without making changes.",
        repoContext: {
          packageScripts: {
            build: "node -e \"process.exit(0)\"",
            test: "node -e \"process.exit(0)\"",
            typecheck: "node -e \"process.exit(0)\""
          },
          topLevelEntries: ["package.json", "src"],
          verificationSignals: [
            {
              command: "npm run build",
              defaultSelected: false,
              ecosystem: "npm",
              kind: "build",
              source: "package.json"
            },
            {
              command: "npm test",
              defaultSelected: true,
              ecosystem: "npm",
              kind: "test",
              source: "package.json"
            },
            {
              command: "npm run typecheck",
              defaultSelected: true,
              ecosystem: "npm",
              kind: "typecheck",
              source: "package.json"
            }
          ]
        },
      }).selectedCommands
    ).toEqual([]);
  });

  it("still selects verification commands when the user explicitly asks to verify", () => {
    expect(
      planVerificationCommands({
        assistantSummary: "",
        changedFiles: [],
        prompt: "Inspect the repo and run the tests to verify the current status.",
        repoContext: {
          packageScripts: {
            test: "node -e \"process.exit(0)\""
          },
          topLevelEntries: ["package.json"],
          verificationSignals: [
            {
              command: "npm test",
              defaultSelected: true,
              ecosystem: "npm",
              kind: "test",
              source: "package.json"
            }
          ]
        },
      }).selectedCommands
    ).toEqual(["npm test"]);
  });

  it("prefers python verification over unrelated npm scripts when only python files changed", () => {
    expect(
      planVerificationCommands({
        assistantSummary: "Implemented the requested Python API and verified it.",
        changedFiles: ["app/main.py", "tests/test_main.py"],
        prompt: "Build a Python service with tests.",
        repoContext: {
          packageScripts: {
            test: "node -e \"process.exit(0)\""
          },
          topLevelEntries: ["package.json", "pyproject.toml", "app", "tests"],
          verificationSignals: [
            {
              command: "npm test",
              defaultSelected: true,
              ecosystem: "npm",
              kind: "test",
              source: "package.json"
            },
            {
              command: "pytest",
              defaultSelected: true,
              ecosystem: "python",
              kind: "test",
              source: "pyproject.toml"
            }
          ]
        }
      }).selectedCommands
    ).toEqual(["pytest"]);
  });

  it("does not infer placeholder npm tests after scaffolding a js app", () => {
    expect(
      planVerificationCommands({
        assistantSummary: "Implemented the requested app.",
        changedFiles: ["pages/index.js", "package.json"],
        prompt: "Build a small Next.js app.",
        repoContext: {
          packageScripts: {
            test: "echo \"Error: no test specified\" && exit 1"
          },
          topLevelEntries: ["package.json", "pages"],
          verificationSignals: []
        }
      }).selectedCommands
    ).toEqual([]);
  });
});
