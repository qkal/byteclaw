import { describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitAssistantLifecycleErrorAndEnd,
  findLifecycleErrorAgentEvent,
} from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession lifecycle billing errors", () => {
  function createAgentEventHarness(options?: { runId?: string; sessionKey?: string }) {
    const onAgentEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      onAgentEvent,
      runId: options?.runId ?? "run",
      sessionKey: options?.sessionKey,
    });
    return { emit, onAgentEvent };
  }

  it("includes provider and model context in lifecycle billing errors", () => {
    const { emit, onAgentEvent } = createAgentEventHarness({
      runId: "run-billing-error",
      sessionKey: "test-session",
    });

    emitAssistantLifecycleErrorAndEnd({
      emit,
      errorMessage: "insufficient credits",
      model: "claude-3-5-sonnet",
      provider: "Anthropic",
    });

    const lifecycleError = findLifecycleErrorAgentEvent(onAgentEvent.mock.calls);
    expect(lifecycleError).toBeDefined();
    expect(lifecycleError?.data?.error).toContain("Anthropic (claude-3-5-sonnet)");
  });
});
