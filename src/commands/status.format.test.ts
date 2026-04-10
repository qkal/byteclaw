import { describe, expect, it } from "vitest";
import { formatPromptCacheCompact, formatTokensCompact } from "./status.format.js";

describe("status cache formatting", () => {
  it("formats explicit cache details for verbose status output", () => {
    expect(
      formatPromptCacheCompact({
        cacheRead: 2000,
        cacheWrite: 1000,
        inputTokens: 2000,
        totalTokens: 5000,
      }),
    ).toBe("40% hit · read 2.0k · write 1.0k");
  });

  it("shows cache writes even before there is a cache hit", () => {
    expect(
      formatPromptCacheCompact({
        cacheRead: 0,
        cacheWrite: 1000,
        inputTokens: 2000,
        totalTokens: 3000,
      }),
    ).toBe("0% hit · write 1.0k");
  });

  it("keeps the compact token suffix aligned with prompt-side cache math", () => {
    expect(
      formatTokensCompact({
        cacheRead: 2000,
        cacheWrite: 500,
        contextTokens: 10_000,
        inputTokens: 500,
        percentUsed: 50,
        totalTokens: 5000,
      }),
    ).toBe("5.0k/10k (50%) · 🗄️ 67% cached");
  });
});
