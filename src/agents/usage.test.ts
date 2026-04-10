import { describe, expect, it } from "vitest";
import {
  derivePromptTokens,
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  normalizeUsage,
} from "./usage.js";

describe("normalizeUsage", () => {
  it("normalizes cache fields from provider response", () => {
    const usage = normalizeUsage({
      cacheRead: 2000,
      cacheWrite: 300,
      input: 1000,
      output: 500,
    });
    expect(usage).toEqual({
      cacheRead: 2000,
      cacheWrite: 300,
      input: 1000,
      output: 500,
      total: undefined,
    });
  });

  it("normalizes cache fields from alternate naming", () => {
    const usage = normalizeUsage({
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 2000,
      input_tokens: 1000,
      output_tokens: 500,
    });
    expect(usage).toEqual({
      cacheRead: 2000,
      cacheWrite: 300,
      input: 1000,
      output: 500,
      total: undefined,
    });
  });

  it("handles cache_read and cache_write naming variants", () => {
    const usage = normalizeUsage({
      cache_read: 1500,
      cache_write: 200,
      input: 1000,
    });
    expect(usage).toEqual({
      cacheRead: 1500,
      cacheWrite: 200,
      input: 1000,
      output: undefined,
      total: undefined,
    });
  });

  it("handles Moonshot/Kimi cached_tokens field", () => {
    // Moonshot v1 returns cached_tokens instead of cache_read_input_tokens
    const usage = normalizeUsage({
      cached_tokens: 19,
      completion_tokens: 9,
      prompt_tokens: 30,
      total_tokens: 39,
    });
    expect(usage).toEqual({
      cacheRead: 19,
      cacheWrite: undefined,
      input: 11,
      output: 9,
      total: 39,
    });
  });

  it("handles Kimi K2 prompt_tokens_details.cached_tokens field", () => {
    // Kimi K2 uses automatic prefix caching and returns cached_tokens in prompt_tokens_details
    const usage = normalizeUsage({
      completion_tokens: 5,
      prompt_tokens: 1113,
      prompt_tokens_details: { cached_tokens: 1024 },
      total_tokens: 1118,
    });
    expect(usage).toEqual({
      cacheRead: 1024,
      cacheWrite: undefined,
      input: 89,
      output: 5,
      total: 1118,
    });
  });

  it("handles OpenAI Responses input_tokens_details.cached_tokens field", () => {
    const usage = normalizeUsage({
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 30,
      total_tokens: 250,
    });
    expect(usage).toEqual({
      cacheRead: 100,
      cacheWrite: undefined,
      input: 20,
      output: 30,
      total: 250,
    });
  });

  it("clamps negative input to zero (pre-subtracted cached_tokens > prompt_tokens)", () => {
    // Pi-ai OpenAI-format providers subtract cached_tokens from prompt_tokens
    // Upstream.  When cached_tokens exceeds prompt_tokens the result is negative.
    const usage = normalizeUsage({
      cacheRead: 5000,
      input: -4900,
      output: 200,
    });
    expect(usage).toEqual({
      cacheRead: 5000,
      cacheWrite: undefined,
      input: 0,
      output: 200,
      total: undefined,
    });
  });

  it("clamps negative prompt_tokens alias to zero", () => {
    const usage = normalizeUsage({
      completion_tokens: 4,
      prompt_tokens: -12,
    });
    expect(usage).toEqual({
      cacheRead: undefined,
      cacheWrite: undefined,
      input: 0,
      output: 4,
      total: undefined,
    });
  });

  it("returns undefined when no valid fields are provided", () => {
    const usage = normalizeUsage(null);
    expect(usage).toBeUndefined();
  });

  it("handles undefined input", () => {
    const usage = normalizeUsage(undefined);
    expect(usage).toBeUndefined();
  });
});

describe("hasNonzeroUsage", () => {
  it("returns true when cache read is nonzero", () => {
    const usage = { cacheRead: 100 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns true when cache write is nonzero", () => {
    const usage = { cacheWrite: 50 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns true when both cache fields are nonzero", () => {
    const usage = { cacheRead: 100, cacheWrite: 50 };
    expect(hasNonzeroUsage(usage)).toBe(true);
  });

  it("returns false when cache fields are zero", () => {
    const usage = { cacheRead: 0, cacheWrite: 0 };
    expect(hasNonzeroUsage(usage)).toBe(false);
  });

  it("returns false for undefined usage", () => {
    expect(hasNonzeroUsage(undefined)).toBe(false);
  });
});

describe("derivePromptTokens", () => {
  it("includes cache tokens in prompt total", () => {
    const usage = {
      cacheRead: 500,
      cacheWrite: 200,
      input: 1000,
    };
    const promptTokens = derivePromptTokens(usage);
    expect(promptTokens).toBe(1700); // 1000 + 500 + 200
  });

  it("handles missing cache fields", () => {
    const usage = {
      input: 1000,
    };
    const promptTokens = derivePromptTokens(usage);
    expect(promptTokens).toBe(1000);
  });

  it("returns undefined for empty usage", () => {
    const promptTokens = derivePromptTokens({});
    expect(promptTokens).toBeUndefined();
  });
});

describe("deriveSessionTotalTokens", () => {
  it("includes cache tokens in total calculation", () => {
    const totalTokens = deriveSessionTotalTokens({
      contextTokens: 4000,
      usage: {
        cacheRead: 500,
        cacheWrite: 200,
        input: 1000,
      },
    });
    expect(totalTokens).toBe(1700); // 1000 + 500 + 200
  });

  it("prefers promptTokens override over derived total", () => {
    const totalTokens = deriveSessionTotalTokens({
      contextTokens: 4000,
      promptTokens: 2500,
      usage: {
        cacheRead: 500,
        cacheWrite: 200,
        input: 1000,
      }, // Override
    });
    expect(totalTokens).toBe(2500);
  });
});
