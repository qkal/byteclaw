import { describe, expect, it, vi } from "vitest";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import {
  createTaskScopedChannelRuntime,
  getChannelRuntimeContext,
  registerChannelRuntimeContext,
  watchChannelRuntimeContexts,
} from "./channel-runtime-context.js";

describe("channel runtime context helpers", () => {
  it("returns inert helpers when no channel runtime exists", () => {
    expect(
      registerChannelRuntimeContext({
        accountId: "default",
        capability: "approval.native",
        channelId: "slack",
        context: { ok: true },
      }),
    ).toBeNull();
    expect(
      getChannelRuntimeContext({
        accountId: "default",
        capability: "approval.native",
        channelId: "slack",
      }),
    ).toBeUndefined();
    expect(
      watchChannelRuntimeContexts({
        accountId: "default",
        capability: "approval.native",
        channelId: "slack",
        onEvent: vi.fn(),
      }),
    ).toBeNull();

    const scoped = createTaskScopedChannelRuntime({});
    expect(scoped.channelRuntime).toBeUndefined();
    expect(() => scoped.dispose()).not.toThrow();
  });

  it("disposes only task-scoped registrations", () => {
    const channelRuntime = createRuntimeChannel();
    const onEvent = vi.fn();
    const unsubscribe = watchChannelRuntimeContexts({
      accountId: "default",
      capability: "approval.native",
      channelId: "slack",
      channelRuntime,
      onEvent,
    });
    const persistentLease = registerChannelRuntimeContext({
      accountId: "default",
      capability: "approval.native",
      channelId: "matrix",
      channelRuntime,
      context: { client: "matrix" },
    });
    const scoped = createTaskScopedChannelRuntime({ channelRuntime });

    registerChannelRuntimeContext({
      accountId: "default",
      capability: "approval.native",
      channelId: "slack",
      channelRuntime: scoped.channelRuntime,
      context: { app: "slack" },
    });

    expect(
      getChannelRuntimeContext({
        accountId: "default",
        capability: "approval.native",
        channelId: "slack",
        channelRuntime,
      }),
    ).toEqual({ app: "slack" });
    expect(
      getChannelRuntimeContext({
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
        channelRuntime,
      }),
    ).toEqual({ client: "matrix" });

    scoped.dispose();

    expect(
      getChannelRuntimeContext({
        accountId: "default",
        capability: "approval.native",
        channelId: "slack",
        channelRuntime,
      }),
    ).toBeUndefined();
    expect(
      getChannelRuntimeContext({
        accountId: "default",
        capability: "approval.native",
        channelId: "matrix",
        channelRuntime,
      }),
    ).toEqual({ client: "matrix" });
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        context: { app: "slack" },
        type: "registered",
      }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "unregistered",
      }),
    );

    persistentLease?.dispose();
    unsubscribe?.();
  });
});
