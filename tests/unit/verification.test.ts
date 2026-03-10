import { describe, expect, it } from "vitest";
import { inferVerificationCommands } from "../../src/app/verification.js";

describe("inferVerificationCommands", () => {
  it("infers commands from common package scripts", () => {
    expect(
      inferVerificationCommands({
        packageScripts: {
          check: "npm run lint && npm test",
          lint: "eslint .",
          test: "vitest run",
          typecheck: "tsc -p tsconfig.json --noEmit"
        }
      })
    ).toEqual([
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run check"
    ]);
  });

  it("returns an empty list when no known scripts exist", () => {
    expect(inferVerificationCommands({ packageScripts: {} })).toEqual([]);
  });
});
