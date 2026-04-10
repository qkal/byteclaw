import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasHeartbeatWakeHandler,
  hasPendingHeartbeatWake,
  requestHeartbeatNow,
  resetHeartbeatWakeStateForTests,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("heartbeat-wake", () => {
  function setRetryOnceHeartbeatHandler() {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ reason: "requests-in-flight", status: "skipped" })
      .mockResolvedValueOnce({ durationMs: 1, status: "ran" });
    setHeartbeatWakeHandler(handler);
    return handler;
  }

  async function expectRetryAfterDefaultDelay(params: {
    handler: ReturnType<typeof vi.fn>;
    initialReason: string;
    expectedRetryReason: string;
  }) {
    setHeartbeatWakeHandler(
      params.handler as unknown as Parameters<typeof setHeartbeatWakeHandler>[0],
    );
    requestHeartbeatNow({ coalesceMs: 0, reason: params.initialReason });

    await vi.advanceTimersByTimeAsync(1);
    expect(params.handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(params.handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(params.handler).toHaveBeenCalledTimes(2);
    expect(params.handler.mock.calls[1]?.[0]).toEqual({ reason: params.expectedRetryReason });
  }

  beforeEach(() => {
    resetHeartbeatWakeStateForTests();
  });

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces multiple wake requests into one run", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ reason: "disabled", status: "skipped" });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({ coalesceMs: 200, reason: "interval" });
    requestHeartbeatNow({ coalesceMs: 200, reason: "exec-event" });
    requestHeartbeatNow({ coalesceMs: 200, reason: "retry" });

    expect(hasPendingHeartbeatWake()).toBe(true);

    await vi.advanceTimersByTimeAsync(199);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: "exec-event" });
    expect(hasPendingHeartbeatWake()).toBe(false);
  });

  it("retries requests-in-flight after the default retry delay", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ reason: "requests-in-flight", status: "skipped" })
      .mockResolvedValueOnce({ durationMs: 1, status: "ran" });
    await expectRetryAfterDefaultDelay({
      expectedRetryReason: "interval",
      handler,
      initialReason: "interval",
    });
  });

  it("keeps retry cooldown even when a sooner request arrives", async () => {
    vi.useFakeTimers();
    const handler = setRetryOnceHeartbeatHandler();

    requestHeartbeatNow({ coalesceMs: 0, reason: "interval" });
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);

    // Retry is now waiting for 1000ms. This should not preempt cooldown.
    requestHeartbeatNow({ coalesceMs: 0, reason: "hook:wake" });
    await vi.advanceTimersByTimeAsync(998);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual({ reason: "hook:wake" });
  });

  it("retries thrown handler errors after the default retry delay", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ reason: "disabled", status: "skipped" });
    await expectRetryAfterDefaultDelay({
      expectedRetryReason: "exec-event",
      handler,
      initialReason: "exec-event",
    });
  });

  it("stale disposer does not clear a newer handler", async () => {
    vi.useFakeTimers();
    const handlerA = vi.fn().mockResolvedValue({ durationMs: 1, status: "ran" });
    const handlerB = vi.fn().mockResolvedValue({ durationMs: 1, status: "ran" });

    // Runner A registers its handler
    const disposeA = setHeartbeatWakeHandler(handlerA);

    // Runner B registers its handler (replaces A)
    const disposeB = setHeartbeatWakeHandler(handlerB);

    // Runner A's stale cleanup runs — should NOT clear handlerB
    disposeA();
    expect(hasHeartbeatWakeHandler()).toBe(true);

    // HandlerB should still work
    requestHeartbeatNow({ coalesceMs: 0, reason: "interval" });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA).not.toHaveBeenCalled();

    // Runner B's dispose should work
    disposeB();
    expect(hasHeartbeatWakeHandler()).toBe(false);
  });

  it("preempts existing timer when a sooner schedule is requested", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ durationMs: 1, status: "ran" });
    setHeartbeatWakeHandler(handler);

    // Schedule for 5 seconds from now
    requestHeartbeatNow({ coalesceMs: 5000, reason: "slow" });

    // Schedule for 100ms from now — should preempt the 5s timer
    requestHeartbeatNow({ coalesceMs: 100, reason: "fast" });

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    // The reason should be "fast" since it was set last
    expect(handler).toHaveBeenCalledWith({ reason: "fast" });
  });

  it("keeps existing timer when later schedule is requested", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ durationMs: 1, status: "ran" });
    setHeartbeatWakeHandler(handler);

    // Schedule for 100ms from now
    requestHeartbeatNow({ coalesceMs: 100, reason: "fast" });

    // Schedule for 5 seconds from now — should NOT preempt
    requestHeartbeatNow({ coalesceMs: 5000, reason: "slow" });

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade a higher-priority pending reason", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ durationMs: 1, status: "ran" });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({ coalesceMs: 100, reason: "exec-event" });
    requestHeartbeatNow({ coalesceMs: 100, reason: "retry" });

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: "exec-event" });
  });

  it("resets running/scheduled flags when new handler is registered", async () => {
    vi.useFakeTimers();

    // Simulate a handler that's mid-execution when SIGUSR1 fires.
    // We do this by having the handler hang forever (never resolve).
    let resolveHang: () => void;
    const hangPromise = new Promise<void>((r) => {
      resolveHang = r;
    });
    const handlerA = vi
      .fn()
      .mockReturnValue(hangPromise.then(() => ({ durationMs: 1, status: "ran" as const })));
    setHeartbeatWakeHandler(handlerA);

    // Trigger the handler — it starts running but never finishes
    requestHeartbeatNow({ coalesceMs: 0, reason: "interval" });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    // Now simulate SIGUSR1: register a new handler while handlerA is still running.
    // Without the fix, `running` would stay true and handlerB would never fire.
    const handlerB = vi.fn().mockResolvedValue({ durationMs: 1, status: "ran" });
    setHeartbeatWakeHandler(handlerB);

    // HandlerB should be able to fire (running was reset)
    requestHeartbeatNow({ coalesceMs: 0, reason: "interval" });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);

    // Clean up the hanging promise
    resolveHang!();
    await Promise.resolve();
  });

  it("clears stale retry cooldown when a new handler is registered", async () => {
    vi.useFakeTimers();
    const handlerA = vi.fn().mockResolvedValue({ reason: "requests-in-flight", status: "skipped" });
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeatNow({ coalesceMs: 0, reason: "interval" });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    // Simulate SIGUSR1 startup with a fresh wake handler.
    const handlerB = vi.fn().mockResolvedValue({ durationMs: 1, status: "ran" });
    setHeartbeatWakeHandler(handlerB);

    requestHeartbeatNow({ coalesceMs: 0, reason: "manual" });
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledWith({ reason: "manual" });
  });

  it("drains pending wake once a handler is registered", async () => {
    vi.useFakeTimers();

    requestHeartbeatNow({ coalesceMs: 0, reason: "manual" });
    await vi.advanceTimersByTimeAsync(1);
    expect(hasPendingHeartbeatWake()).toBe(true);

    const handler = vi.fn().mockResolvedValue({ reason: "disabled", status: "skipped" });
    setHeartbeatWakeHandler(handler);

    await vi.advanceTimersByTimeAsync(249);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: "manual" });
    expect(hasPendingHeartbeatWake()).toBe(false);
  });

  it("forwards wake target fields and preserves them across retries", async () => {
    vi.useFakeTimers();
    const handler = setRetryOnceHeartbeatHandler();

    requestHeartbeatNow({
      agentId: "ops",
      coalesceMs: 0,
      reason: "cron:job-1",
      sessionKey: "agent:ops:discord:channel:alerts",
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({
      agentId: "ops",
      reason: "cron:job-1",
      sessionKey: "agent:ops:discord:channel:alerts",
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual({
      agentId: "ops",
      reason: "cron:job-1",
      sessionKey: "agent:ops:discord:channel:alerts",
    });
  });

  it("executes distinct targeted wakes queued in the same coalescing window", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ durationMs: 1, status: "ran" });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({
      agentId: "ops",
      coalesceMs: 100,
      reason: "cron:job-a",
      sessionKey: "agent:ops:discord:channel:alerts",
    });
    requestHeartbeatNow({
      agentId: "main",
      coalesceMs: 100,
      reason: "cron:job-b",
      sessionKey: "agent:main:telegram:group:-1001",
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        {
          agentId: "ops",
          reason: "cron:job-a",
          sessionKey: "agent:ops:discord:channel:alerts",
        },
        {
          agentId: "main",
          reason: "cron:job-b",
          sessionKey: "agent:main:telegram:group:-1001",
        },
      ]),
    );
  });
});
