import { describe, expect, it, vi } from "vitest";
import { emitSessionLifecycleEvent, onSessionLifecycleEvent } from "./session-lifecycle-events.js";

describe("session lifecycle events", () => {
  it("delivers events to active listeners and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onSessionLifecycleEvent(listener);

    emitSessionLifecycleEvent({
      label: "Main",
      reason: "created",
      sessionKey: "agent:main:main",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      label: "Main",
      reason: "created",
      sessionKey: "agent:main:main",
    });

    unsubscribe();
    emitSessionLifecycleEvent({
      reason: "updated",
      sessionKey: "agent:main:main",
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps notifying other listeners when one throws", () => {
    const noisy = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    const unsubscribeNoisy = onSessionLifecycleEvent(noisy);
    const unsubscribeHealthy = onSessionLifecycleEvent(healthy);

    expect(() =>
      emitSessionLifecycleEvent({
        reason: "resumed",
        sessionKey: "agent:main:main",
      }),
    ).not.toThrow();

    expect(noisy).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);

    unsubscribeNoisy();
    unsubscribeHealthy();
  });
});
