import type {
  ButtonInteraction,
  ComponentData,
  ModalInteraction,
  StringSelectMenuInteraction,
} from "@buape/carbon";
import { ChannelType } from "discord-api-types/v10";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { buildPluginBindingApprovalCustomId } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import {
  dispatchPluginInteractiveHandlerMock,
  dispatchReplyMock,
  enqueueSystemEventMock,
  readSessionUpdatedAtMock,
  recordInboundSessionMock,
  resetDiscordComponentRuntimeMocks,
  resolveStorePathMock,
} from "../test-support/component-runtime.js";

type CreateDiscordComponentButton =
  typeof import("./agent-components.js").createDiscordComponentButton;
type CreateDiscordComponentModal =
  typeof import("./agent-components.js").createDiscordComponentModal;
type CreateDiscordComponentStringSelect =
  typeof import("./agent-components.js").createDiscordComponentStringSelect;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;

let createDiscordComponentButton: CreateDiscordComponentButton;
let createDiscordComponentStringSelect: CreateDiscordComponentStringSelect;
let createDiscordComponentModal: CreateDiscordComponentModal;
let clearDiscordComponentEntries: typeof import("../components-registry.js").clearDiscordComponentEntries;
let registerDiscordComponentEntries: typeof import("../components-registry.js").registerDiscordComponentEntries;
let resolveDiscordComponentEntry: typeof import("../components-registry.js").resolveDiscordComponentEntry;
let resolveDiscordModalEntry: typeof import("../components-registry.js").resolveDiscordModalEntry;
let sendComponents: typeof import("../send.components.js");

let lastDispatchCtx: Record<string, unknown> | undefined;

function getLastRecordedCtx(): Record<string, unknown> | undefined {
  const params = recordInboundSessionMock.mock.calls.at(-1)?.[0] as
    | { ctx?: Record<string, unknown> }
    | undefined;
  return params?.ctx;
}

describe("discord component interactions", () => {
  let editDiscordComponentMessageMock: ReturnType<typeof vi.spyOn>;
  const createCfg = (): OpenClawConfig =>
    ({
      channels: {
        discord: {
          replyToMode: "first",
        },
      },
    }) as OpenClawConfig;

  const createDiscordConfig = (overrides?: Partial<DiscordAccountConfig>): DiscordAccountConfig =>
    ({
      replyToMode: "first",
      ...overrides,
    }) as DiscordAccountConfig;

  type DispatchParams = Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];

  type ComponentContext = Parameters<CreateDiscordComponentButton>[0];

  const createComponentContext = (overrides?: Partial<ComponentContext>) =>
    ({
      accountId: "default",
      allowFrom: ["123456789"],
      cfg: createCfg(),
      discordConfig: createDiscordConfig(),
      dmPolicy: "allowlist",
      token: "token",
      ...overrides,
    }) as ComponentContext;

  const createComponentButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const rest = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
      patch: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({}),
    };
    const interaction = {
      client: { rest },
      customId: "occomp:cid=btn_1",
      defer,
      message: { id: "msg-1" },
      rawData: { channel_id: "dm-channel", id: "interaction-1" },
      reply,
      user: { discriminator: "0001", id: "123456789", username: "AgentUser" },
      ...overrides,
    } as unknown as ButtonInteraction;
    return { defer, interaction, reply };
  };

  const createComponentSelectInteraction = (
    overrides: Partial<StringSelectMenuInteraction> = {},
  ) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const rest = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
      patch: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({}),
    };
    const interaction = {
      client: { rest },
      customId: "occomp:cid=sel_1",
      defer,
      message: { id: "msg-1" },
      rawData: { channel_id: "dm-channel", id: "interaction-select-1" },
      reply,
      user: { discriminator: "0001", id: "123456789", username: "AgentUser" },
      values: ["alpha"],
      ...overrides,
    } as unknown as StringSelectMenuInteraction;
    return { defer, interaction, reply };
  };

  const createModalInteraction = (overrides: Partial<ModalInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const rest = {
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
      patch: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({}),
    };
    const fields = {
      getRoleSelect: (_key: string) => [],
      getStringSelect: (_key: string) => undefined,
      getText: (key: string) => (key === "fld_1" ? "Casey" : undefined),
      getUserSelect: (_key: string) => [],
    };
    const interaction = {
      acknowledge,
      client: { rest },
      customId: "ocmodal:mid=mdl_1",
      fields,
      rawData: { channel_id: "dm-channel", id: "interaction-2" },
      reply,
      user: { discriminator: "0001", id: "123456789", username: "AgentUser" },
      ...overrides,
    } as unknown as ModalInteraction;
    return { acknowledge, interaction, reply };
  };

  const createButtonEntry = (
    overrides: Partial<DiscordComponentEntry> = {},
  ): DiscordComponentEntry => ({
    accountId: "default",
    agentId: "agent-1",
    id: "btn_1",
    kind: "button",
    label: "Approve",
    messageId: "msg-1",
    sessionKey: "session-1",
    ...overrides,
  });

  const createModalEntry = (overrides: Partial<DiscordModalEntry> = {}): DiscordModalEntry => ({
    accountId: "default",
    agentId: "agent-2",
    fields: [
      {
        id: "fld_1",
        label: "Name",
        name: "name",
        type: "text",
      },
    ],
    id: "mdl_1",
    messageId: "msg-2",
    sessionKey: "session-2",
    title: "Details",
    ...overrides,
  });

  const createGuildPluginButton = (allowFrom: string[]) =>
    createDiscordComponentButton(
      createComponentContext({
        allowFrom,
        cfg: {
          channels: { discord: { replyToMode: "first" } },
          commands: { useAccessGroups: true },
        } as OpenClawConfig,
      }),
    );

  const createGuildPluginButtonInteraction = (interactionId: string) =>
    createComponentButtonInteraction({
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: interactionId,
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
    });

  async function expectPluginGuildInteractionAuth(params: {
    allowFrom: string[];
    interactionId: string;
    isAuthorizedSender: boolean;
  }) {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      duplicate: false,
      handled: true,
      matched: true,
    });

    const button = createGuildPluginButton(params.allowFrom);
    const { interaction } = createGuildPluginButtonInteraction(params.interactionId);

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          auth: { isAuthorizedSender: params.isAuthorizedSender },
        }),
      }),
    );
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  }

  beforeAll(async () => {
    ({
      createDiscordComponentButton,
      createDiscordComponentStringSelect,
      createDiscordComponentModal,
    } = await import("./agent-components.js"));
    ({
      clearDiscordComponentEntries,
      registerDiscordComponentEntries,
      resolveDiscordComponentEntry,
      resolveDiscordModalEntry,
    } = await import("../components-registry.js"));
    sendComponents = await import("../send.components.js");
  });

  beforeEach(() => {
    editDiscordComponentMessageMock = vi
      .spyOn(sendComponents, "editDiscordComponentMessage")
      .mockResolvedValue({
        channelId: "dm-channel",
        messageId: "msg-1",
      });
    clearDiscordComponentEntries();
    resetDiscordComponentRuntimeMocks();
    lastDispatchCtx = undefined;
    enqueueSystemEventMock.mockClear();
    dispatchReplyMock
      .mockClear()
      .mockImplementation(
        async (params: DispatchParams): Promise<DispatchReplyWithBufferedBlockDispatcherResult> => {
          lastDispatchCtx = params.ctx;
          await params.dispatcherOptions.deliver({ text: "ok" }, { kind: "final" });
          return {
            counts: {
              block: 0,
              final: 1,
              tool: 0,
            },
            queuedFinal: false,
          };
        },
      );
    recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
    readSessionUpdatedAtMock.mockClear().mockReturnValue(undefined);
    resolveStorePathMock.mockClear().mockReturnValue("/tmp/openclaw-sessions-test.json");
    dispatchPluginInteractiveHandlerMock.mockReset().mockResolvedValue({
      duplicate: false,
      handled: false,
      matched: false,
    });
  });

  it("routes button clicks with reply references", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe('Clicked "Approve".');
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
  });

  it("records DM component interactions with user originating targets", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(lastDispatchCtx?.OriginatingTo).toBe("user:123456789");
    expect(lastDispatchCtx?.To).toBe("channel:dm-channel");
    expect(getLastRecordedCtx()?.OriginatingTo).toBe("user:123456789");
    expect(getLastRecordedCtx()?.To).toBe("channel:dm-channel");
  });

  it("uses raw callbackData for built-in fallback when no plugin handler matches", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "/codex_resume --browse-projects" })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe("/codex_resume --browse-projects");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("preserves selected values for select fallback when no plugin handler matches", async () => {
    registerDiscordComponentEntries({
      entries: [
        {
          accountId: "default",
          agentId: "agent-1",
          callbackData: "/codex_resume",
          id: "sel_1",
          kind: "select",
          label: "Pick",
          messageId: "msg-1",
          options: [{ label: "Alpha", value: "alpha" }],
          selectType: "string",
          sessionKey: "session-1",
        },
      ],
      modals: [],
    });

    const select = createDiscordComponentStringSelect(createComponentContext());
    const { interaction, reply } = createComponentSelectInteraction();

    await select.run(interaction, { cid: "sel_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe('Selected Alpha from "Pick".');
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("keeps reusable buttons active after use", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ reusable: true })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction();
    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    const { interaction: secondInteraction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "dm-channel",
        id: "interaction-2",
      } as unknown as ButtonInteraction["rawData"],
    });
    await button.run(secondInteraction, { cid: "btn_1" } as ComponentData);

    expect(dispatchReplyMock).toHaveBeenCalledTimes(2);
    expect(resolveDiscordComponentEntry({ consume: false, id: "btn_1" })).not.toBeNull();
  });

  it("blocks buttons when allowedUsers does not match", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ allowedUsers: ["999"] })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
    expect(resolveDiscordComponentEntry({ consume: false, id: "btn_1" })).not.toBeNull();
  });

  it("blocks buttons from guilds removed from the allowlist", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        cfg: {
          channels: { discord: { groupPolicy: "allowlist", replyToMode: "first" } },
        } as OpenClawConfig,
        discordConfig: createDiscordConfig({ groupPolicy: "allowlist" }),
        guildEntries: {},
      }),
    );
    const { interaction, reply } = createComponentButtonInteraction({
      guild: { id: "gone", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
      rawData: {
        channel_id: "guild-channel",
        guild_id: "gone",
        id: "interaction-guild-removed",
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("blocks buttons on disabled guild channels", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        cfg: {
          channels: { discord: { groupPolicy: "allowlist", replyToMode: "first" } },
        } as OpenClawConfig,
        discordConfig: createDiscordConfig({ groupPolicy: "allowlist" }),
        guildEntries: { g1: { channels: { "guild-channel": { enabled: false } } } },
      }),
    );
    const { interaction, reply } = createComponentButtonInteraction({
      guild: { id: "g1", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
      rawData: {
        channel_id: "guild-channel",
        guild_id: "g1",
        id: "interaction-guild-disabled",
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("blocks buttons on denied guild channels", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        cfg: {
          channels: { discord: { groupPolicy: "allowlist", replyToMode: "first" } },
        } as OpenClawConfig,
        discordConfig: createDiscordConfig({ groupPolicy: "allowlist" }),
        guildEntries: { g1: { channels: { "guild-channel": { enabled: false } } } },
      }),
    );
    const { interaction, reply } = createComponentButtonInteraction({
      guild: { id: "g1", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
      rawData: {
        channel_id: "guild-channel",
        guild_id: "g1",
        id: "interaction-guild-denied",
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  async function runModalSubmission(params?: { reusable?: boolean }) {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry({ reusable: params?.reusable ?? false })],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        discordConfig: createDiscordConfig({ replyToMode: "all" }),
      }),
    );
    const { interaction, acknowledge } = createModalInteraction();

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);
    return { acknowledge };
  }

  it("routes modal submissions with field values", async () => {
    const { acknowledge } = await runModalSubmission();

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.BodyForAgent).toContain('Form "Details" submitted.');
    expect(lastDispatchCtx?.BodyForAgent).toContain("- Name: Casey");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(resolveDiscordModalEntry({ id: "mdl_1" })).toBeNull();
  });

  it("does not mark guild modal events as command-authorized for non-allowlisted users", async () => {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry()],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        allowFrom: ["owner-1"],
        cfg: {
          channels: { discord: { replyToMode: "first" } },
          commands: { useAccessGroups: true },
        } as OpenClawConfig,
      }),
    );
    const { interaction, acknowledge } = createModalInteraction({
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ModalInteraction["guild"],
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: "interaction-guild-1",
        member: { roles: [] },
      } as unknown as ModalInteraction["rawData"],
    });

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.CommandAuthorized).toBe(false);
  });

  it("marks guild modal events as command-authorized for allowlisted users", async () => {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry()],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        allowFrom: ["123456789"],
        cfg: {
          channels: { discord: { replyToMode: "first" } },
          commands: { useAccessGroups: true },
        } as OpenClawConfig,
      }),
    );
    const { interaction, acknowledge } = createModalInteraction({
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ModalInteraction["guild"],
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: "interaction-guild-2",
        member: { roles: [] },
      } as unknown as ModalInteraction["rawData"],
    });

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.CommandAuthorized).toBe(true);
  });

  it("keeps reusable modal entries active after submission", async () => {
    const { acknowledge } = await runModalSubmission({ reusable: true });

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(resolveDiscordModalEntry({ consume: false, id: "mdl_1" })).not.toBeNull();
  });

  it("passes false auth to plugin Discord interactions for non-allowlisted guild users", async () => {
    await expectPluginGuildInteractionAuth({
      allowFrom: ["owner-1"],
      interactionId: "interaction-guild-plugin-1",
      isAuthorizedSender: false,
    });
  });

  it("passes true auth to plugin Discord interactions for allowlisted guild users", async () => {
    await expectPluginGuildInteractionAuth({
      allowFrom: ["123456789"],
      interactionId: "interaction-guild-plugin-2",
      isAuthorizedSender: true,
    });
  });

  it("routes plugin Discord interactions in group DMs by channel id instead of sender id", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      duplicate: false,
      handled: true,
      matched: true,
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        discordConfig: createDiscordConfig({
          dm: {
            groupChannels: ["group-dm-1"],
            groupEnabled: true,
          },
        }),
      }),
    );
    const { interaction } = createComponentButtonInteraction({
      channel: {
        id: "group-dm-1",
        type: ChannelType.GroupDM,
      } as unknown as ButtonInteraction["channel"],
      rawData: {
        channel_id: "group-dm-1",
        id: "interaction-group-dm-1",
      } as unknown as ButtonInteraction["rawData"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          conversationId: "channel:group-dm-1",
          senderId: "123456789",
        }),
      }),
    );
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("marks built-in Group DM component fallbacks with group metadata", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        discordConfig: createDiscordConfig({
          dm: {
            groupChannels: ["group-dm-1"],
            groupEnabled: true,
          },
        }),
      }),
    );
    const { interaction, reply } = createComponentButtonInteraction({
      channel: {
        id: "group-dm-1",
        name: "incident-room",
        type: ChannelType.GroupDM,
      } as unknown as ButtonInteraction["channel"],
      rawData: {
        channel_id: "group-dm-1",
        id: "interaction-group-dm-fallback",
      } as unknown as ButtonInteraction["rawData"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx).toMatchObject({
      ChatType: "group",
      ConversationLabel: "Group DM #incident-room channel id:group-dm-1",
      From: "discord:group:group-dm-1",
    });
  });

  it("blocks Group DM modal triggers before showing the modal", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ kind: "modal-trigger", modalId: "mdl_1" })],
      modals: [createModalEntry()],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const showModal = vi.fn().mockResolvedValue(undefined);
    const { interaction, reply } = createComponentButtonInteraction({
      channel: {
        id: "group-dm-1",
        name: "incident-room",
        type: ChannelType.GroupDM,
      } as unknown as ButtonInteraction["channel"],
      rawData: {
        channel_id: "group-dm-1",
        id: "interaction-group-dm-modal-trigger",
      } as unknown as ButtonInteraction["rawData"],
      showModal,
    });

    await button.run(interaction, { cid: "btn_1", mid: "mdl_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "Group DM interactions are disabled.",
      ephemeral: true,
    });
    expect(showModal).not.toHaveBeenCalled();
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("does not fall through to Claw when a plugin Discord interaction already replied", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockImplementation(async (params: unknown) => {
      const typedParams = params as {
        respond: { reply: (payload: { text: string; ephemeral: boolean }) => Promise<void> };
      };
      await typedParams.respond.reply({ ephemeral: true, text: "✓" });
      return {
        duplicate: false,
        handled: true,
        matched: true,
      };
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("lets plugin Discord interactions clear components after acknowledging", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockImplementation(async (params: unknown) => {
      const typedParams = params as {
        respond: {
          acknowledge: () => Promise<void>;
          clearComponents: (payload: { text: string }) => Promise<void>;
        };
      };
      await typedParams.respond.acknowledge();
      await typedParams.respond.clearComponents({ text: "Handled" });
      return {
        duplicate: false,
        handled: true,
        matched: true,
      };
    });

    const button = createDiscordComponentButton(createComponentContext());
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const baseInteraction = createComponentButtonInteraction().interaction as unknown as Record<
      string,
      unknown
    >;
    const interaction = {
      ...baseInteraction,
      acknowledge,
      reply,
      update,
    } as unknown as ButtonInteraction;

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      components: [],
      content: "Handled",
    });
    expect(update).not.toHaveBeenCalled();
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("falls through to built-in Discord component routing when a plugin declines handling", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      duplicate: false,
      handled: false,
      matched: true,
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("resolves plugin binding approvals without falling through to Claw", async () => {
    registerDiscordComponentEntries({
      entries: [
        createButtonEntry({
          callbackData: buildPluginBindingApprovalCustomId("approval-1", "allow-once"),
        }),
      ],
      modals: [],
    });
    const button = createDiscordComponentButton(createComponentContext());
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const baseInteraction = createComponentButtonInteraction().interaction as unknown as Record<
      string,
      unknown
    >;
    const interaction = {
      ...baseInteraction,
      acknowledge,
      followUp,
    } as unknown as ButtonInteraction;

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(editDiscordComponentMessageMock).toHaveBeenCalledWith(
      "user:123456789",
      "msg-1",
      { text: expect.any(String) },
      { accountId: "default" },
    );
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });
});
