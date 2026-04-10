import { describe, expect, it, vi } from "vitest";
import { resolvePreparedReplyQueueState } from "./get-reply-run-queue.js";

describe("resolvePreparedReplyQueueState", () => {
  it("continues immediately when queue policy does not require waiting", async () => {
    const resolveBusyState = vi.fn(() => ({
      activeSessionId: undefined,
      isActive: false,
      isStreaming: false,
    }));

    const result = await resolvePreparedReplyQueueState({
      abortActiveRun: vi.fn(),
      activeRunQueueAction: "enqueue-followup",
      activeSessionId: undefined,
      queueMode: "followup",
      refreshPreparedState: vi.fn(),
      resolveBusyState,
      sessionId: "session-1",
      sessionKey: "session-key",
      waitForActiveRunEnd: vi.fn(),
    });

    expect(result).toEqual({
      busyState: { activeSessionId: undefined, isActive: false, isStreaming: false },
      kind: "continue",
    });
    expect(resolveBusyState).toHaveBeenCalledOnce();
  });

  it("aborts and waits for interrupt mode before continuing", async () => {
    const abortActiveRun = vi.fn(() => true);
    const waitForActiveRunEnd = vi.fn(async () => undefined);
    const refreshPreparedState = vi.fn(async () => undefined);
    const resolveBusyState = vi.fn(() => ({
      activeSessionId: undefined,
      isActive: false,
      isStreaming: false,
    }));

    const result = await resolvePreparedReplyQueueState({
      abortActiveRun,
      activeRunQueueAction: "run-now",
      activeSessionId: "session-active",
      queueMode: "interrupt",
      refreshPreparedState,
      resolveBusyState,
      sessionId: "session-1",
      sessionKey: "session-key",
      waitForActiveRunEnd,
    });

    expect(abortActiveRun).toHaveBeenCalledWith("session-active");
    expect(waitForActiveRunEnd).toHaveBeenCalledWith("session-active");
    expect(refreshPreparedState).toHaveBeenCalledOnce();
    expect(result).toEqual({
      busyState: { activeSessionId: undefined, isActive: false, isStreaming: false },
      kind: "continue",
    });
  });

  it("rechecks after wait and returns shutdown reply when still busy", async () => {
    const result = await resolvePreparedReplyQueueState({
      abortActiveRun: vi.fn(() => true),
      activeRunQueueAction: "run-now",
      activeSessionId: "session-active",
      queueMode: "interrupt",
      refreshPreparedState: vi.fn(async () => undefined),
      resolveBusyState: () => ({
        activeSessionId: "session-after-wait",
        isActive: true,
        isStreaming: false,
      }),
      sessionId: "session-1",
      sessionKey: "session-key",
      waitForActiveRunEnd: vi.fn(async () => undefined),
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
      },
    });
  });
});
