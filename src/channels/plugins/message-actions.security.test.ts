import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelPlugin } from "./types.js";

const handleAction = vi.fn(async () => jsonResult({ ok: true }));

const emptyRegistry = createTestRegistry([]);

const discordPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
    },
    id: "discord",
    label: "Discord",
  }),
  actions: {
    describeMessageTool: () => ({ actions: ["kick"] }),
    handleAction,
    requiresTrustedRequesterSender: ({ action, toolContext }) =>
      Boolean(action === "kick" && toolContext),
    supportsAction: ({ action }) => action === "kick",
  },
};

describe("dispatchChannelMessageAction trusted sender guard", () => {
  beforeEach(() => {
    handleAction.mockClear();
    setActivePluginRegistry(
      createTestRegistry([{ plugin: discordPlugin, pluginId: "discord", source: "test" }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("rejects privileged discord moderation action without trusted sender in tool context", async () => {
    await expect(
      dispatchChannelMessageAction({
        action: "kick",
        cfg: {} as OpenClawConfig,
        channel: "discord",
        params: { guildId: "g1", userId: "u1" },
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).rejects.toThrow("Trusted sender identity is required for discord:kick");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("allows privileged discord moderation action with trusted sender in tool context", async () => {
    await dispatchChannelMessageAction({
      action: "kick",
      cfg: {} as OpenClawConfig,
      channel: "discord",
      params: { guildId: "g1", userId: "u1" },
      requesterSenderId: "trusted-user",
      toolContext: { currentChannelProvider: "discord" },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("does not require trusted sender without tool context", async () => {
    await dispatchChannelMessageAction({
      action: "kick",
      cfg: {} as OpenClawConfig,
      channel: "discord",
      params: { guildId: "g1", userId: "u1" },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });
});
