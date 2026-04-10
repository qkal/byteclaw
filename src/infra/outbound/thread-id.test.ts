import { describe, expect, it } from "vitest";
import { normalizeOutboundThreadId } from "./thread-id.js";

describe("normalizeOutboundThreadId", () => {
  it.each([
    { expected: undefined, input: undefined },
    { expected: undefined, input: null },
    { expected: undefined, input: "   " },
    { expected: "123", input: 123.9 },
    { expected: "456", input: " 456 " },
    { expected: undefined, input: Number.NaN },
    { expected: undefined, input: Number.POSITIVE_INFINITY },
  ])("normalizes outbound thread id for %j", ({ input, expected }) => {
    expect(normalizeOutboundThreadId(input)).toBe(expected);
  });
});
