import { describe, expect, it } from "vitest";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./failover-policy.js";

describe("resolveRunFailoverDecision", () => {
  it("escalates retry-limit exhaustion for replay-safe failover reasons", () => {
    expect(
      resolveRunFailoverDecision({
        failoverReason: "rate_limit",
        fallbackConfigured: true,
        stage: "retry_limit",
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "rate_limit",
    });
  });

  it("keeps retry-limit as a local error for non-escalating reasons", () => {
    expect(
      resolveRunFailoverDecision({
        failoverReason: "timeout",
        fallbackConfigured: true,
        stage: "retry_limit",
      }),
    ).toEqual({
      action: "return_error_payload",
    });
  });

  it("prefers prompt-side profile rotation before fallback", () => {
    expect(
      resolveRunFailoverDecision({
        aborted: false,
        failoverFailure: true,
        failoverReason: "rate_limit",
        fallbackConfigured: true,
        profileRotated: false,
        stage: "prompt",
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "rate_limit",
    });
  });

  it("falls back after prompt rotation is exhausted", () => {
    expect(
      resolveRunFailoverDecision({
        aborted: false,
        failoverFailure: true,
        failoverReason: "rate_limit",
        fallbackConfigured: true,
        profileRotated: true,
        stage: "prompt",
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "rate_limit",
    });
  });

  it("treats classified assistant-side 429s as rotation candidates even without error stopReason", () => {
    expect(
      resolveRunFailoverDecision({
        aborted: false,
        failoverFailure: false,
        failoverReason: "rate_limit",
        fallbackConfigured: true,
        profileRotated: false,
        stage: "assistant",
        timedOut: false,
        timedOutDuringCompaction: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "rate_limit",
    });
  });

  it("falls back after assistant rotation is exhausted", () => {
    expect(
      resolveRunFailoverDecision({
        aborted: false,
        failoverFailure: false,
        failoverReason: "rate_limit",
        fallbackConfigured: true,
        profileRotated: true,
        stage: "assistant",
        timedOut: false,
        timedOutDuringCompaction: false,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "rate_limit",
    });
  });

  it("does nothing for assistant turns without failover signals", () => {
    expect(
      resolveRunFailoverDecision({
        aborted: false,
        failoverFailure: false,
        failoverReason: null,
        fallbackConfigured: true,
        profileRotated: false,
        stage: "assistant",
        timedOut: false,
        timedOutDuringCompaction: false,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });
});

describe("mergeRetryFailoverReason", () => {
  it("preserves the previous classified reason when the current one is null", () => {
    expect(
      mergeRetryFailoverReason({
        failoverReason: null,
        previous: "rate_limit",
      }),
    ).toBe("rate_limit");
  });

  it("records timeout when no classified reason is present", () => {
    expect(
      mergeRetryFailoverReason({
        failoverReason: null,
        previous: null,
        timedOut: true,
      }),
    ).toBe("timeout");
  });
});
