import type { ButtonInteraction, ComponentData, StringSelectMenuInteraction } from "@buape/carbon";
import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { expectPairingReplyText } from "../../../../test/helpers/pairing-reply.js";
import {
  enqueueSystemEventMock,
  readAllowFromStoreMock,
  resetDiscordComponentRuntimeMocks,
  upsertPairingRequestMock,
} from "../test-support/component-runtime.js";
import { resolveComponentInteractionContext } from "./agent-components-helpers.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
  resolveDiscordComponentOriginatingTo,
} from "./agent-components.js";

describe("agent components", () => {
  const defaultDmSessionKey = buildAgentSessionKey({
    accountId: "default",
    agentId: "main",
    channel: "discord",
    peer: { id: "123456789", kind: "direct" },
  });
  const defaultGroupDmSessionKey = buildAgentSessionKey({
    accountId: "default",
    agentId: "main",
    channel: "discord",
    peer: { id: "group-dm-channel", kind: "group" },
  });

  const createCfg = (): OpenClawConfig => ({}) as OpenClawConfig;
  const createBaseDmInteraction = (overrides: Record<string, unknown> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      defer,
      rawData: { channel_id: "dm-channel" },
      reply,
      user: { discriminator: "1234", id: "123456789", username: "Alice" },
      ...overrides,
    };
    return { defer, interaction, reply };
  };

  const createDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction(
      overrides as Record<string, unknown>,
    );
    return {
      defer,
      interaction: interaction as unknown as ButtonInteraction,
      reply,
    };
  };

  const createDmSelectInteraction = (overrides: Partial<StringSelectMenuInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseDmInteraction({
      values: ["alpha"],
      ...(overrides as Record<string, unknown>),
    });
    return {
      defer,
      interaction: interaction as unknown as StringSelectMenuInteraction,
      reply,
    };
  };

  const createBaseGroupDmInteraction = (overrides: Record<string, unknown> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      channel: {
        id: "group-dm-channel",
        name: "incident-room",
        type: ChannelType.GroupDM,
      },
      defer,
      rawData: { channel_id: "group-dm-channel" },
      reply,
      user: { discriminator: "1234", id: "123456789", username: "Alice" },
      ...overrides,
    };
    return { defer, interaction, reply };
  };

  const createGroupDmButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const { interaction, defer, reply } = createBaseGroupDmInteraction(
      overrides as Record<string, unknown>,
    );
    return {
      defer,
      interaction: interaction as unknown as ButtonInteraction,
      reply,
    };
  };

  beforeEach(() => {
    resetDiscordComponentRuntimeMocks();
    resetSystemEventsForTest();
  });

  it("sends pairing reply when DM sender is not allowlisted", async () => {
    const button = createAgentComponentButton({
      accountId: "default",
      cfg: createCfg(),
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    const pairingText = String(reply.mock.calls[0]?.[0]?.content ?? "");
    const code = expectPairingReplyText(pairingText, {
      channel: "discord",
      idLine: "Your Discord user id: 123456789",
    });
    expect(pairingText).toContain(`openclaw pairing approve discord ${code}`);
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([]);
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
  });

  it("blocks DM interactions in allowlist mode when sender is not in configured allowFrom", async () => {
    const button = createAgentComponentButton({
      accountId: "default",
      cfg: createCfg(),
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("classifies Group DM component interactions separately from direct messages", async () => {
    const { interaction, defer } = createGroupDmButtonInteraction();

    const ctx = await resolveComponentInteractionContext({
      defer: false,
      interaction,
      label: "group-dm-test",
    });

    expect(defer).not.toHaveBeenCalled();
    expect(ctx).toMatchObject({
      channelId: "group-dm-channel",
      isDirectMessage: false,
      isGroupDm: true,
      rawGuildId: undefined,
      userId: "123456789",
    });
  });

  it("blocks Group DM interactions that are not allowlisted even when dmPolicy is open", async () => {
    const button = createAgentComponentButton({
      accountId: "default",
      cfg: createCfg(),
      discordConfig: {
        dm: {
          groupChannels: ["other-group-dm"],
          groupEnabled: true,
        },
      } as DiscordAccountConfig,
      dmPolicy: "open",
    });
    const { interaction, defer, reply } = createGroupDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultGroupDmSessionKey)).toEqual([]);
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("routes allowlisted Group DM interactions to the group session without applying DM policy", async () => {
    const button = createAgentComponentButton({
      accountId: "default",
      cfg: createCfg(),
      discordConfig: {
        dm: {
          groupChannels: ["group-dm-channel"],
          groupEnabled: true,
        },
      } as DiscordAccountConfig,
      dmPolicy: "disabled",
    });
    const { interaction, defer, reply } = createGroupDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      expect.objectContaining({
        sessionKey: defaultGroupDmSessionKey,
      }),
    );
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("authorizes DM interactions from pairing-store entries in pairing mode", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      accountId: "default",
      cfg: createCfg(),
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      expect.objectContaining({
        sessionKey: defaultDmSessionKey,
      }),
    );
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
  });

  it("allows DM component interactions in open mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      accountId: "default",
      cfg: createCfg(),
      dmPolicy: "open",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      expect.objectContaining({
        sessionKey: defaultDmSessionKey,
      }),
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("uses user conversation ids for direct-message component originating targets", () => {
    expect(
      resolveDiscordComponentOriginatingTo({
        channelId: "dm-channel",
        isDirectMessage: true,
        userId: "123456789",
      }),
    ).toBe("user:123456789");
    expect(
      resolveDiscordComponentOriginatingTo({
        channelId: "guild-channel",
        isDirectMessage: false,
        userId: "123456789",
      }),
    ).toBe("channel:guild-channel");
  });

  it("blocks DM component interactions in disabled mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      accountId: "default",
      cfg: createCfg(),
      dmPolicy: "disabled",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "DM interactions are disabled.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("matches tag-based allowlist entries for DM select menus", async () => {
    const select = createAgentSelectMenu({
      accountId: "default",
      allowFrom: ["Alice#1234"],
      cfg: createCfg(),
      discordConfig: { dangerouslyAllowNameMatching: true } as DiscordAccountConfig,
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmSelectInteraction();

    await select.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord select menu: hello interacted by Alice#1234 (123456789) (selected: alpha)]",
      expect.objectContaining({
        sessionKey: defaultDmSessionKey,
      }),
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("accepts cid payloads for agent button interactions", async () => {
    const button = createAgentComponentButton({
      accountId: "default",
      allowFrom: ["123456789"],
      cfg: createCfg(),
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello_cid" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello_cid clicked by Alice#1234 (123456789)]",
      expect.objectContaining({
        sessionKey: defaultDmSessionKey,
      }),
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("keeps malformed percent cid values without throwing", async () => {
    const button = createAgentComponentButton({
      accountId: "default",
      allowFrom: ["123456789"],
      cfg: createCfg(),
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello%2G" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello%2G clicked by Alice#1234 (123456789)]",
      expect.objectContaining({
        sessionKey: defaultDmSessionKey,
      }),
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });
});
