import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  __testing,
  listAllChannelSupportedActions,
  listChannelSupportedActions,
} from "./channel-tools.js";

describe("channel tools", () => {
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    const plugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => {
          throw new Error("boom");
        },
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      id: "test",
      meta: {
        blurb: "test plugin",
        docsPath: "/channels/test",
        id: "test",
        label: "Test",
        selectionLabel: "Test",
      },
    };

    __testing.resetLoggedListActionErrors();
    errorSpy.mockClear();
    setActivePluginRegistry(createTestRegistry([{ plugin, pluginId: "test", source: "test" }]));
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("skips crashing plugins and logs once", () => {
    const cfg = {} as OpenClawConfig;
    expect(listAllChannelSupportedActions({ cfg })).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    expect(listAllChannelSupportedActions({ cfg })).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not infer poll actions from outbound adapters when action discovery omits them", () => {
    const plugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => ({ actions: [] }),
      },
      capabilities: { chatTypes: ["direct"], polls: true },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      id: "polltest",
      meta: {
        blurb: "poll plugin",
        docsPath: "/channels/polltest",
        id: "polltest",
        label: "Poll Test",
        selectionLabel: "Poll Test",
      },
      outbound: {
        deliveryMode: "gateway",
        sendPoll: async () => ({ channel: "polltest", messageId: "poll-1" }),
      },
    };

    setActivePluginRegistry(createTestRegistry([{ plugin, pluginId: "polltest", source: "test" }]));

    const cfg = {} as OpenClawConfig;
    expect(listChannelSupportedActions({ cfg, channel: "polltest" })).toEqual([]);
    expect(listAllChannelSupportedActions({ cfg })).toEqual([]);
  });

  it("normalizes channel aliases before listing supported actions", () => {
    const plugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => ({ actions: ["react"] }),
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      id: "telegram",
      meta: {
        aliases: ["tg"],
        blurb: "telegram plugin",
        docsPath: "/channels/telegram",
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
      },
    };

    setActivePluginRegistry(createTestRegistry([{ plugin, pluginId: "telegram", source: "test" }]));

    const cfg = {} as OpenClawConfig;
    expect(listChannelSupportedActions({ cfg, channel: "tg" })).toEqual(["react"]);
  });

  it("uses unified message tool discovery", () => {
    const plugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => ({
          actions: ["react"],
        }),
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      id: "telegram",
      meta: {
        blurb: "telegram plugin",
        docsPath: "/channels/telegram",
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
      },
    };

    setActivePluginRegistry(createTestRegistry([{ plugin, pluginId: "telegram", source: "test" }]));

    const cfg = {} as OpenClawConfig;
    expect(listChannelSupportedActions({ cfg, channel: "telegram" })).toEqual(["react"]);
  });
});
