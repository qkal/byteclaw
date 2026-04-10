import { describe, expect, it } from "vitest";
import {
  type FallbackNoticeState,
  resolveActiveFallbackState,
  resolveFallbackTransition,
} from "./fallback-state.js";

const baseAttempt = {
  error: "Provider demo-primary is in cooldown (all profiles unavailable)",
  model: "demo-primary/model-a",
  provider: "demo-primary",
  reason: "rate_limit" as const,
};

const activeFallbackState: FallbackNoticeState = {
  fallbackNoticeActiveModel: "demo-fallback/model-b",
  fallbackNoticeReason: "rate limit",
  fallbackNoticeSelectedModel: "demo-primary/model-a",
};

function resolveDemoFallbackTransition(
  overrides: Partial<Parameters<typeof resolveFallbackTransition>[0]> = {},
) {
  return resolveFallbackTransition({
    activeModel: "model-b",
    activeProvider: "demo-fallback",
    attempts: [baseAttempt],
    selectedModel: "model-a",
    selectedProvider: "demo-primary",
    state: {},
    ...overrides,
  });
}

describe("fallback-state", () => {
  it.each([
    {
      expected: { active: true, reason: "rate limit" },
      name: "treats fallback as active only when state matches selected and active refs",
      state: activeFallbackState,
    },
    {
      expected: { active: false, reason: undefined },
      name: "does not treat runtime drift as fallback when persisted state does not match",
      state: {
        fallbackNoticeActiveModel: "demo-fallback/model-b",
        fallbackNoticeReason: "rate limit",
        fallbackNoticeSelectedModel: "other-provider/other-model",
      } satisfies FallbackNoticeState,
    },
  ])("$name", ({ state, expected }) => {
    const resolved = resolveActiveFallbackState({
      activeModelRef: "demo-fallback/model-b",
      selectedModelRef: "demo-primary/model-a",
      state,
    });

    expect(resolved).toEqual(expected);
  });

  it("marks fallback transition when selected->active pair changes", () => {
    const resolved = resolveDemoFallbackTransition();

    expect(resolved.fallbackActive).toBe(true);
    expect(resolved.fallbackTransitioned).toBe(true);
    expect(resolved.fallbackCleared).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.reasonSummary).toBe("rate limit");
    expect(resolved.nextState.selectedModel).toBe("demo-primary/model-a");
    expect(resolved.nextState.activeModel).toBe("demo-fallback/model-b");
  });

  it("normalizes fallback reason whitespace for summaries", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, reason: "rate_limit\n\tburst" }],
    });

    expect(resolved.reasonSummary).toBe("rate limit burst");
  });

  it("prefers formatted transient error details over generic rate-limit labels", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [
        {
          ...baseAttempt,
          error: "429 Too Many Requests: Claude Max usage limit reached, try again in 6 minutes.",
        },
      ],
    });

    expect(resolved.reasonSummary).toContain("HTTP 429: Too Many Requests");
    expect(resolved.reasonSummary).toContain("Claude Max usage limit reached");
  });

  it("refreshes reason when fallback remains active with same model pair", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, reason: "timeout" }],
      state: activeFallbackState,
    });

    expect(resolved.fallbackTransitioned).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.nextState.reason).toBe("timeout");
  });

  it("marks fallback as cleared when runtime returns to selected model", () => {
    const resolved = resolveDemoFallbackTransition({
      activeModel: "model-a",
      activeProvider: "demo-primary",
      attempts: [],
      selectedModel: "model-a",
      state: activeFallbackState,
    });

    expect(resolved.fallbackActive).toBe(false);
    expect(resolved.fallbackCleared).toBe(true);
    expect(resolved.fallbackTransitioned).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.nextState.selectedModel).toBeUndefined();
    expect(resolved.nextState.activeModel).toBeUndefined();
    expect(resolved.nextState.reason).toBeUndefined();
  });
});
