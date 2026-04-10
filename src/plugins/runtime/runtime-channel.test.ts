import { describe, expect, it, vi } from "vitest";
import { createRuntimeChannel } from "./runtime-channel.js";

describe("runtimeContexts", () => {
  it("registers, resolves, watches, and unregisters contexts", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const unsubscribe = channel.runtimeContexts.watch({
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get<{ client: string }>({
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
      }),
    ).toEqual({ client: "ok" });
    expect(onEvent).toHaveBeenCalledWith({
      context: { client: "ok" },
      key: {
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
      },
      type: "registered",
    });

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
      }),
    ).toBeUndefined();
    expect(onEvent).toHaveBeenLastCalledWith({
      key: {
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
      },
      type: "unregistered",
    });

    unsubscribe();
  });

  it("auto-disposes registrations when the abort signal fires", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const lease = channel.runtimeContexts.register({
      abortSignal: controller.signal,
      accountId: "default",
      capability: "approval.native",
      channelId: "telegram",
      context: { token: "abc" },
    });

    controller.abort();

    expect(
      channel.runtimeContexts.get({
        accountId: "default",
        capability: "approval.native",
        channelId: "telegram",
      }),
    ).toBeUndefined();
    lease.dispose();
  });

  it("does not register contexts when the abort signal is already aborted", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const controller = new AbortController();
    controller.abort();
    channel.runtimeContexts.watch({
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      abortSignal: controller.signal,
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      context: { client: "stale" },
    });

    expect(
      channel.runtimeContexts.get({
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
      }),
    ).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    lease.dispose();
  });

  it("isolates watcher exceptions so registration and disposal still complete", () => {
    const channel = createRuntimeChannel();
    const badWatcher = vi.fn((event) => {
      throw new Error(`boom:${event.type}`);
    });
    const goodWatcher = vi.fn();

    channel.runtimeContexts.watch({
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      onEvent: badWatcher,
    });
    channel.runtimeContexts.watch({
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      onEvent: goodWatcher,
    });

    const lease = channel.runtimeContexts.register({
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get({
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
      }),
    ).toEqual({ client: "ok" });
    expect(badWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "registered",
      }),
    );
    expect(goodWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "registered",
      }),
    );

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
      }),
    ).toBeUndefined();
    expect(badWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "unregistered",
      }),
    );
    expect(goodWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "unregistered",
      }),
    );
  });

  it("auto-disposes when a watcher aborts during the registered event", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const onEvent = vi.fn((event) => {
      if (event.type === "registered") {
        controller.abort();
      }
    });

    channel.runtimeContexts.watch({
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      abortSignal: controller.signal,
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get({
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
      }),
    ).toBeUndefined();
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "registered",
      }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "unregistered",
      }),
    );

    lease.dispose();
  });
});
