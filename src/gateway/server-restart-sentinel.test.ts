import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const mocks = vi.hoisted(() => ({
  ackDelivery: vi.fn(async () => {}),
  consumeRestartSentinel: vi.fn(async () => ({
    payload: {
      deliveryContext: {
        accountId: "acct-2",
        channel: "whatsapp",
        to: "+15550002",
      },
      sessionKey: "agent:main:main",
    },
  })),
  deliverOutboundPayloads: vi.fn(async () => [{ channel: "whatsapp", messageId: "msg-1" }]),
  deliveryContextFromSession: vi.fn(() => undefined),
  enqueueDelivery: vi.fn(async () => "queue-1"),
  enqueueSystemEvent: vi.fn(),
  failDelivery: vi.fn(async () => {}),
  formatRestartSentinelMessage: vi.fn(() => "restart message"),
  getChannelPlugin: vi.fn(() => undefined),
  loadSessionEntry: vi.fn(() => ({ cfg: {}, entry: {} })),
  logWarn: vi.fn(),
  mergeDeliveryContext: vi.fn((a?: Record<string, unknown>, b?: Record<string, unknown>) => ({
    ...b,
    ...a,
  })),
  normalizeChannelId: vi.fn((channel: string) => channel),
  parseSessionThreadInfo: vi.fn(() => ({ baseSessionKey: null, threadId: undefined })),
  requestHeartbeatNow: vi.fn(),
  resolveAnnounceTargetFromKey: vi.fn(() => null),
  resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
  resolveOutboundTarget: vi.fn(() => ({ ok: true as const, to: "+15550002" })),
  resolveSessionAgentId: vi.fn(() => "agent-from-key"),
  summarizeRestartSentinel: vi.fn(() => "restart summary"),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: mocks.resolveSessionAgentId,
}));

vi.mock("../infra/restart-sentinel.js", () => ({
  consumeRestartSentinel: mocks.consumeRestartSentinel,
  formatRestartSentinelMessage: mocks.formatRestartSentinelMessage,
  summarizeRestartSentinel: mocks.summarizeRestartSentinel,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
}));

vi.mock("../config/sessions/delivery-info.js", () => ({
  parseSessionThreadInfo: mocks.parseSessionThreadInfo,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../agents/tools/sessions-send-helpers.js", () => ({
  resolveAnnounceTargetFromKey: mocks.resolveAnnounceTargetFromKey,
}));

vi.mock("../utils/delivery-context.js", () => ({
  deliveryContextFromSession: mocks.deliveryContextFromSession,
  mergeDeliveryContext: mocks.mergeDeliveryContext,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: mocks.resolveOutboundTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  ackDelivery: mocks.ackDelivery,
  enqueueDelivery: mocks.enqueueDelivery,
  failDelivery: mocks.failDelivery,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", async () => await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow: mocks.requestHeartbeatNow,
    }),
  ));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: mocks.logWarn,
  })),
}));

const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");

describe("scheduleRestartSentinelWake", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useRealTimers();
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        deliveryContext: {
          accountId: "acct-2",
          channel: "whatsapp",
          to: "+15550002",
        },
        sessionKey: "agent:main:main",
      },
    });
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]);
    mocks.enqueueDelivery.mockReset();
    mocks.enqueueDelivery.mockResolvedValue("queue-1");
    mocks.ackDelivery.mockClear();
    mocks.failDelivery.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.requestHeartbeatNow.mockClear();
    mocks.logWarn.mockClear();
  });

  it("enqueues the sentinel note and wakes the session even when outbound delivery succeeds", async () => {
    const deps = {} as never;

    await scheduleRestartSentinelWake({ deps });

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        bestEffort: false,
        channel: "whatsapp",
        deps,
        session: { agentId: "agent-from-key", key: "agent:main:main" },
        skipQueue: true,
        to: "+15550002",
      }),
    );
    expect(mocks.enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        bestEffort: false,
        channel: "whatsapp",
        payloads: [{ text: "restart message" }],
        to: "+15550002",
      }),
    );
    expect(mocks.ackDelivery).toHaveBeenCalledWith("queue-1");
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
      }),
    );
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "wake",
      sessionKey: "agent:main:main",
    });
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("retries outbound delivery once and logs a warning without dropping the agent wake", async () => {
    vi.useFakeTimers();
    mocks.deliverOutboundPayloads
      .mockRejectedValueOnce(new Error("transport not ready"))
      .mockResolvedValueOnce([{ channel: "whatsapp", messageId: "msg-2" }]);

    const wakePromise = scheduleRestartSentinelWake({ deps: {} as never });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(750);
    await wakePromise;

    expect(mocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(mocks.deliverOutboundPayloads).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        skipQueue: true,
      }),
    );
    expect(mocks.deliverOutboundPayloads).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        skipQueue: true,
      }),
    );
    expect(mocks.ackDelivery).toHaveBeenCalledWith("queue-1");
    expect(mocks.failDelivery).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("retrying in 750ms"),
      expect.objectContaining({
        attempt: 1,
        channel: "whatsapp",
        maxAttempts: 2,
        sessionKey: "agent:main:main",
        to: "+15550002",
      }),
    );
  });

  it("keeps one queued restart notice when outbound retries are exhausted", async () => {
    vi.useFakeTimers();
    mocks.deliverOutboundPayloads
      .mockRejectedValueOnce(new Error("transport not ready"))
      .mockRejectedValueOnce(new Error("transport still not ready"));

    const wakePromise = scheduleRestartSentinelWake({ deps: {} as never });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(750);
    await wakePromise;

    expect(mocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
    expect(mocks.ackDelivery).not.toHaveBeenCalled();
    expect(mocks.failDelivery).toHaveBeenCalledWith("queue-1", "transport still not ready");
  });

  it("prefers top-level sentinel threadId for wake routing context", async () => {
    // Legacy or malformed sentinel JSON can still carry a nested threadId.
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        deliveryContext: {
          accountId: "acct-2",
          channel: "whatsapp",
          threadId: "stale-thread",
          to: "+15550002",
        } as never,
        sessionKey: "agent:main:main",
        threadId: "fresh-thread",
      },
    } as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "restart message",
      expect.objectContaining({
        deliveryContext: expect.objectContaining({
          threadId: "fresh-thread",
        }),
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("does not wake the main session when the sentinel has no sessionKey", async () => {
    mocks.consumeRestartSentinel.mockResolvedValue({
      payload: {
        message: "restart message",
      },
    } as unknown as Awaited<ReturnType<typeof mocks.consumeRestartSentinel>>);

    await scheduleRestartSentinelWake({ deps: {} as never });

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("restart message", {
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
