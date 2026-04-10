import { describe, expect, it } from "vitest";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    childSessionKey: "agent:main:subagent:child",
    cleanup: "keep",
    createdAt: 0,
    endedAt: 1000,
    requesterDisplayKey: "main",
    requesterSessionKey: "agent:main:main",
    runId: "run-1",
    task: "test",
    ...overrides,
  };
}

describe("resolveDeferredCleanupDecision", () => {
  const now = 2000;

  it("defers completion-message cleanup while descendants are still pending", () => {
    const decision = resolveDeferredCleanupDecision({
      activeDescendantRuns: 2,
      announceCompletionHardExpiryMs: 30 * 60_000,
      announceExpiryMs: 5 * 60_000,
      deferDescendantDelayMs: 1000,
      entry: makeEntry({ expectsCompletionMessage: true }),
      maxAnnounceRetryCount: 3,
      now,
      resolveAnnounceRetryDelayMs: () => 2000,
    });

    expect(decision).toEqual({ delayMs: 1000, kind: "defer-descendants" });
  });

  it("hard-expires completion-message cleanup when descendants never settle", () => {
    const decision = resolveDeferredCleanupDecision({
      activeDescendantRuns: 1,
      announceCompletionHardExpiryMs: 30 * 60_000,
      announceExpiryMs: 5 * 60_000,
      deferDescendantDelayMs: 1000,
      entry: makeEntry({ endedAt: now - (30 * 60_000 + 1), expectsCompletionMessage: true }),
      maxAnnounceRetryCount: 3,
      now,
      resolveAnnounceRetryDelayMs: () => 2000,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry" });
  });

  it("keeps regular expiry behavior for non-completion flows", () => {
    const decision = resolveDeferredCleanupDecision({
      activeDescendantRuns: 0,
      announceCompletionHardExpiryMs: 30 * 60_000,
      announceExpiryMs: 5 * 60_000,
      deferDescendantDelayMs: 1000,
      entry: makeEntry({ endedAt: now - (5 * 60_000 + 1), expectsCompletionMessage: false }),
      maxAnnounceRetryCount: 3,
      now,
      resolveAnnounceRetryDelayMs: () => 2000,
    });

    expect(decision).toEqual({ kind: "give-up", reason: "expiry", retryCount: 1 });
  });

  it("uses retry backoff for completion-message flows once descendants are settled", () => {
    const decision = resolveDeferredCleanupDecision({
      activeDescendantRuns: 0,
      announceCompletionHardExpiryMs: 30 * 60_000,
      announceExpiryMs: 5 * 60_000,
      deferDescendantDelayMs: 1000,
      entry: makeEntry({ announceRetryCount: 1, expectsCompletionMessage: true }),
      maxAnnounceRetryCount: 3,
      now,
      resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1000,
    });

    expect(decision).toEqual({ kind: "retry", resumeDelayMs: 2000, retryCount: 2 });
  });
});
