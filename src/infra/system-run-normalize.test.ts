import { describe, expect, it } from "vitest";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";

describe("system run normalization helpers", () => {
  it.each([
    { expected: "hello", value: "  hello  " },
    { expected: null, value: " \n\t " },
    { expected: null, value: 42 },
    { expected: null, value: null },
  ])("normalizes non-empty strings for %j", ({ value, expected }) => {
    expect(normalizeNonEmptyString(value)).toBe(expected);
  });

  it.each([
    { expected: [" alpha ", "42", "false"], value: [" alpha ", 42, false] },
    { expected: [], value: undefined },
    { expected: [], value: "alpha" },
  ])("normalizes string arrays for %j", ({ value, expected }) => {
    expect(normalizeStringArray(value)).toEqual(expected);
  });
});
