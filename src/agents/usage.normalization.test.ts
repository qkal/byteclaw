import { describe, expect, it } from "vitest";
import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "./usage.js";

describe("normalizeUsage", () => {
  it("normalizes Anthropic-style snake_case usage", () => {
    const usage = normalizeUsage({
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 50,
      input_tokens: 1200,
      output_tokens: 340,
      total_tokens: 1790,
    });
    expect(usage).toEqual({
      cacheRead: 50,
      cacheWrite: 200,
      input: 1200,
      output: 340,
      total: 1790,
    });
  });

  it("normalizes OpenAI-style prompt/completion usage", () => {
    const usage = normalizeUsage({
      completion_tokens: 123,
      prompt_tokens: 987,
      total_tokens: 1110,
    });
    expect(usage).toEqual({
      cacheRead: undefined,
      cacheWrite: undefined,
      input: 987,
      output: 123,
      total: 1110,
    });
  });

  it("returns undefined for empty usage objects", () => {
    expect(normalizeUsage({})).toBeUndefined();
  });

  it("guards against empty/zero usage overwrites", () => {
    expect(hasNonzeroUsage(undefined)).toBe(false);
    expect(hasNonzeroUsage(null)).toBe(false);
    expect(hasNonzeroUsage({})).toBe(false);
    expect(hasNonzeroUsage({ input: 0, output: 0 })).toBe(false);
    expect(hasNonzeroUsage({ input: 1 })).toBe(true);
    expect(hasNonzeroUsage({ total: 1 })).toBe(true);
  });

  it("does not clamp derived session total tokens to the context window", () => {
    expect(
      deriveSessionTotalTokens({
        contextTokens: 200_000,
        usage: {
          cacheRead: 2_400_000,
          cacheWrite: 0,
          input: 27,
          total: 2_402_300,
        },
      }),
    ).toBe(2_400_027);
  });

  it("uses prompt tokens when within context window", () => {
    expect(
      deriveSessionTotalTokens({
        contextTokens: 200_000,
        usage: {
          cacheRead: 300,
          cacheWrite: 50,
          input: 1200,
          total: 2000,
        },
      }),
    ).toBe(1550);
  });

  it("prefers explicit prompt token overrides", () => {
    expect(
      deriveSessionTotalTokens({
        contextTokens: 200_000,
        promptTokens: 65_000,
        usage: {
          cacheRead: 300,
          cacheWrite: 50,
          input: 1200,
          total: 9999,
        },
      }),
    ).toBe(65_000);
  });
});
