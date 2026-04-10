import { describe, expect, it } from "vitest";
import { normalizePackageTagInput } from "./package-tag.js";

describe("normalizePackageTagInput", () => {
  const packageNames = ["openclaw", "@openclaw/plugin"] as const;

  it.each([
    { expected: null, input: undefined },
    { expected: null, input: "   " },
    { expected: "beta", input: "openclaw@beta" },
    { expected: "2026.2.24", input: "@openclaw/plugin@2026.2.24" },
    { expected: null, input: "openclaw@   " },
    { expected: null, input: "openclaw" },
    { expected: null, input: " @openclaw/plugin " },
    { expected: "latest", input: " latest " },
    { expected: "@other/plugin@beta", input: "@other/plugin@beta" },
    { expected: "openclawer@beta", input: "openclawer@beta" },
  ] satisfies readonly { input: string | undefined; expected: string | null }[])(
    "normalizes %j",
    ({ input, expected }) => {
      expect(normalizePackageTagInput(input, packageNames)).toBe(expected);
    },
  );
});
