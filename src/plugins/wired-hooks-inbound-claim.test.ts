import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const inboundClaimEvent = {
  accountId: "default",
  channel: "discord",
  content: "who are you",
  conversationId: "channel:1",
  isGroup: true,
};

const inboundClaimCtx = {
  accountId: "default",
  channelId: "discord",
  conversationId: "channel:1",
};

function createInboundClaimTelegramEvent() {
  return {
    accountId: "default",
    channel: "telegram",
    content: "who are you",
    conversationId: "123:topic:77",
    isGroup: true,
  };
}

function createInboundClaimTelegramCtx() {
  return {
    accountId: "default",
    channelId: "telegram",
    conversationId: "123:topic:77",
  };
}

describe("inbound_claim hook runner", () => {
  it("stops at the first handler that claims the event", async () => {
    const first = vi.fn().mockResolvedValue({ handled: true });
    const second = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry([
      { handler: first, hookName: "inbound_claim" },
      { handler: second, hookName: "inbound_claim" },
    ]);

    const result = await runner.runInboundClaim(
      createInboundClaimTelegramEvent(),
      createInboundClaimTelegramCtx(),
    );

    expect(result).toEqual({ handled: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("continues to the next handler when a higher-priority handler throws", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry(
      [
        { handler: failing, hookName: "inbound_claim" },
        { handler: succeeding, hookName: "inbound_claim" },
      ],
      { logger },
    );

    const result = await runner.runInboundClaim(
      {
        ...createInboundClaimTelegramEvent(),
        content: "hi",
        conversationId: "123",
        isGroup: false,
      },
      {
        ...createInboundClaimTelegramCtx(),
        conversationId: "123",
      },
    );

    expect(result).toEqual({ handled: true });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("inbound_claim handler from test-plugin failed: Error: boom"),
    );
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("can target a single plugin when core already owns the binding", async () => {
    const first = vi.fn().mockResolvedValue({ handled: true });
    const second = vi.fn().mockResolvedValue({ handled: true });
    const { registry, runner } = createHookRunnerWithRegistry([
      { handler: first, hookName: "inbound_claim" },
      { handler: second, hookName: "inbound_claim" },
    ]);
    registry.typedHooks[1].pluginId = "other-plugin";

    const result = await runner.runInboundClaimForPlugin(
      "test-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ handled: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("can target a loaded non-default plugin without mutating the helper registry", async () => {
    const first = vi.fn().mockResolvedValue({ handled: true });
    const second = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry([
      { handler: first, hookName: "inbound_claim", pluginId: "alpha-plugin" },
      { handler: second, hookName: "inbound_claim", pluginId: "beta-plugin" },
    ]);

    const result = await runner.runInboundClaimForPlugin(
      "beta-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ handled: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("reports missing_plugin when the bound plugin is not loaded", async () => {
    const { registry, runner } = createHookRunnerWithRegistry([]);
    registry.plugins = [];

    const result = await runner.runInboundClaimForPluginOutcome(
      "missing-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ status: "missing_plugin" });
  });

  it("reports no_handler when the plugin is loaded but has no targeted hooks", async () => {
    const { runner } = createHookRunnerWithRegistry([]);

    const result = await runner.runInboundClaimForPluginOutcome(
      "test-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ status: "no_handler" });
  });

  it("reports error when a targeted handler throws and none claim the event", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const { runner } = createHookRunnerWithRegistry(
      [{ handler: failing, hookName: "inbound_claim" }],
      { logger },
    );

    const result = await runner.runInboundClaimForPluginOutcome(
      "test-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ error: "boom", status: "error" });
  });
});
