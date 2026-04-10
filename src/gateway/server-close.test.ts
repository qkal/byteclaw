import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  logWarn: vi.fn(),
};
const WEBSOCKET_CLOSE_GRACE_MS = 1000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [],
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: vi.fn(async () => undefined),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: mocks.logWarn,
  })),
}));

const { createGatewayCloseHandler } = await import("./server-close.js");

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.logWarn.mockClear();
  });

  it("unsubscribes lifecycle listeners during shutdown", async () => {
    const lifecycleUnsub = vi.fn();
    const stopTaskRegistryMaintenance = vi.fn();
    const close = createGatewayCloseHandler({
      agentUnsub: null,
      bonjourStop: null,
      broadcast: vi.fn(),
      canvasHost: null,
      canvasHostServer: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      cron: { stop: vi.fn() },
      dedupeCleanup: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      heartbeatRunner: { stop: vi.fn() } as never,
      heartbeatUnsub: null,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
      lifecycleUnsub,
      mediaCleanup: null,
      nodePresenceTimers: new Map(),
      pluginServices: null,
      stopChannel: vi.fn(async () => undefined),
      stopTaskRegistryMaintenance,
      tailscaleCleanup: null,
      tickInterval: setInterval(() => undefined, 60_000),
      transcriptUnsub: null,
      updateCheckStop: null,
      wss: { close: (cb: () => void) => cb() } as never,
    });

    await close({ reason: "test shutdown" });

    expect(lifecycleUnsub).toHaveBeenCalledTimes(1);
    expect(stopTaskRegistryMaintenance).toHaveBeenCalledTimes(1);
  });

  it("terminates lingering websocket clients when websocket close exceeds the grace window", async () => {
    vi.useFakeTimers();

    let closeCallback: (() => void) | null = null;
    const terminate = vi.fn(() => {
      closeCallback?.();
    });
    const close = createGatewayCloseHandler({
      agentUnsub: null,
      bonjourStop: null,
      broadcast: vi.fn(),
      canvasHost: null,
      canvasHostServer: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      cron: { stop: vi.fn() },
      dedupeCleanup: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      heartbeatRunner: { stop: vi.fn() } as never,
      heartbeatUnsub: null,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
      lifecycleUnsub: null,
      mediaCleanup: null,
      nodePresenceTimers: new Map(),
      pluginServices: null,
      stopChannel: vi.fn(async () => undefined),
      stopTaskRegistryMaintenance: null,
      tailscaleCleanup: null,
      tickInterval: setInterval(() => undefined, 60_000),
      transcriptUnsub: null,
      updateCheckStop: null,
      wss: {
        clients: new Set([{ terminate }]),
        close: (cb: () => void) => {
          closeCallback = cb;
        },
      } as never,
    });

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS);
    await closePromise;

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close exceeded 1000ms"),
      ),
    ).toBe(true);
  });

  it("continues shutdown when websocket close hangs without tracked clients", async () => {
    vi.useFakeTimers();

    const close = createGatewayCloseHandler({
      agentUnsub: null,
      bonjourStop: null,
      broadcast: vi.fn(),
      canvasHost: null,
      canvasHostServer: null,
      chatRunState: { clear: vi.fn() },
      clients: new Set(),
      configReloader: { stop: vi.fn(async () => undefined) },
      cron: { stop: vi.fn() },
      dedupeCleanup: setInterval(() => undefined, 60_000),
      healthInterval: setInterval(() => undefined, 60_000),
      heartbeatRunner: { stop: vi.fn() } as never,
      heartbeatUnsub: null,
      httpServer: {
        close: (cb: (err?: Error | null) => void) => cb(null),
        closeIdleConnections: vi.fn(),
      } as never,
      lifecycleUnsub: null,
      mediaCleanup: null,
      nodePresenceTimers: new Map(),
      pluginServices: null,
      stopChannel: vi.fn(async () => undefined),
      stopTaskRegistryMaintenance: null,
      tailscaleCleanup: null,
      tickInterval: setInterval(() => undefined, 60_000),
      transcriptUnsub: null,
      updateCheckStop: null,
      wss: {
        clients: new Set(),
        close: () => undefined,
      } as never,
    });

    const closePromise = close({ reason: "test shutdown" });
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_GRACE_MS + WEBSOCKET_CLOSE_FORCE_CONTINUE_MS);
    await closePromise;

    expect(
      mocks.logWarn.mock.calls.some(([message]) =>
        String(message).includes("websocket server close still pending after 250ms force window"),
      ),
    ).toBe(true);
  });
});
