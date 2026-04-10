import { describe, expect, it } from "vitest";
import { normalizeFailoverDecisionObservationBase } from "./failover-observation.js";

function normalizeObservation(
  overrides: Partial<Parameters<typeof normalizeFailoverDecisionObservationBase>[0]>,
) {
  return normalizeFailoverDecisionObservationBase({
    aborted: false,
    failoverReason: null,
    fallbackConfigured: false,
    model: "mock-1",
    profileFailureReason: null,
    profileId: "openai:p1",
    provider: "openai",
    rawError: "",
    runId: "run:base",
    stage: "assistant",
    timedOut: false,
    ...overrides,
  });
}

describe("normalizeFailoverDecisionObservationBase", () => {
  it("fills timeout observation reasons for deadline timeouts without provider error text", () => {
    expect(
      normalizeObservation({
        runId: "run:timeout",
        timedOut: true,
      }),
    ).toMatchObject({
      failoverReason: "timeout",
      profileFailureReason: "timeout",
      timedOut: true,
    });
  });

  it("preserves explicit failover reasons", () => {
    expect(
      normalizeObservation({
        failoverReason: "overloaded",
        fallbackConfigured: true,
        profileFailureReason: "overloaded",
        rawError: '{"error":{"type":"overloaded_error"}}',
        runId: "run:overloaded",
        timedOut: true,
      }),
    ).toMatchObject({
      failoverReason: "overloaded",
      profileFailureReason: "overloaded",
      timedOut: true,
    });
  });
});
