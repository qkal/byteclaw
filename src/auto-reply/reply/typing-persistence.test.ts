import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTypingController } from "./typing.js";

describe("typing persistence bug fix", () => {
  let onReplyStartSpy: Mock;
  let onCleanupSpy: Mock;
  let controller: ReturnType<typeof createTypingController>;

  beforeEach(() => {
    vi.useFakeTimers();
    onReplyStartSpy = vi.fn();
    onCleanupSpy = vi.fn();

    controller = createTypingController({
      log: vi.fn(),
      onCleanup: onCleanupSpy,
      onReplyStart: onReplyStartSpy,
      typingIntervalSeconds: 6,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should NOT restart typing after markRunComplete is called", async () => {
    // Start typing normally
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run as complete (but not yet dispatch idle)
    controller.markRunComplete();

    // Advance time to trigger the typing interval (6 seconds)
    vi.advanceTimersByTime(6000);

    // BUG: The typing loop should NOT call onReplyStart again
    // Because the run is already complete
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);
    expect(onReplyStartSpy).not.toHaveBeenCalledTimes(2);
  });

  it("should stop typing when both runComplete and dispatchIdle are true", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete
    controller.markRunComplete();
    expect(onCleanupSpy).not.toHaveBeenCalled();

    // Mark dispatch idle - should trigger cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);

    // After cleanup, typing interval should not restart typing
    vi.advanceTimersByTime(6000);
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1); // Still only the initial call
  });

  it("should prevent typing restart even if cleanup is delayed", async () => {
    // Start typing
    await controller.startTypingLoop();
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Mark run complete (but dispatch not idle yet - simulating cleanup delay)
    controller.markRunComplete();

    // Multiple typing intervals should NOT restart typing
    vi.advanceTimersByTime(6000); // First interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Second interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000); // Third interval
    expect(onReplyStartSpy).toHaveBeenCalledTimes(1);

    // Eventually dispatch becomes idle and triggers cleanup
    controller.markDispatchIdle();
    expect(onCleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an inert controller when typing callbacks are absent", async () => {
    const inert = createTypingController({});

    await inert.onReplyStart();
    await inert.startTypingLoop();
    await inert.startTypingOnText("hello");
    inert.refreshTypingTtl();
    inert.markRunComplete();
    inert.markDispatchIdle();
    inert.cleanup();

    expect(inert.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
