import { describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_CACHE_TTL_CUSTOM_TYPE,
  appendAttemptCacheTtlIfNeeded,
} from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt cache-ttl tracking after compaction", () => {
  it("skips cache-ttl append when compaction completed during the attempt", async () => {
    const sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const appended = appendAttemptCacheTtlIfNeeded({
      compactionOccurredThisAttempt: true,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      isCacheTtlEligibleProvider: () => true,
      modelApi: "anthropic-messages",
      modelId: "claude-sonnet-4-20250514",
      now: 123,
      provider: "anthropic",
      sessionManager,
      timedOutDuringCompaction: false,
    });

    expect(appended).toBe(false);
    expect(sessionManager.appendCustomEntry).not.toHaveBeenCalledWith(
      ATTEMPT_CACHE_TTL_CUSTOM_TYPE,
      expect.anything(),
    );
  });

  it("appends cache-ttl when no compaction completed during the attempt", async () => {
    const sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const appended = appendAttemptCacheTtlIfNeeded({
      compactionOccurredThisAttempt: false,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      isCacheTtlEligibleProvider: () => true,
      modelApi: "anthropic-messages",
      modelId: "claude-sonnet-4-20250514",
      now: 123,
      provider: "anthropic",
      sessionManager,
      timedOutDuringCompaction: false,
    });

    expect(appended).toBe(true);
    expect(sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      ATTEMPT_CACHE_TTL_CUSTOM_TYPE,
      expect.objectContaining({
        modelId: "claude-sonnet-4-20250514",
        provider: "anthropic",
        timestamp: 123,
      }),
    );
  });
});
