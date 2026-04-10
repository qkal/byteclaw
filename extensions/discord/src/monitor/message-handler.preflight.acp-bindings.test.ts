import * as conversationRuntime from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/channels/plugins/binding-routing.js", async () => {
  const { createConfiguredBindingConversationRuntimeModuleMock } =
    await import("../test-support/configured-binding-runtime.js");
  return await createConfiguredBindingConversationRuntimeModuleMock(
    {
      ensureConfiguredBindingRouteReadyMock,
      resolveConfiguredBindingRouteMock,
    },
    () =>
      vi.importActual<typeof import("../../../../src/channels/plugins/binding-routing.js")>(
        "../../../../src/channels/plugins/binding-routing.js",
      ),
  );
});

import { __testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";

const GUILD_ID = "guild-1";
const CHANNEL_ID = "channel-1";

function createConfiguredDiscordBinding() {
  return {
    record: {
      bindingId: "config:acp:discord:default:channel-1",
      boundAt: 0,
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: CHANNEL_ID,
      },
      metadata: {
        agentId: "codex",
        mode: "persistent",
        source: "config",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:binding:discord:default:abc123",
    },
    spec: {
      accountId: "default",
      agentId: "codex",
      channel: "discord",
      conversationId: CHANNEL_ID,
      mode: "persistent",
    },
  } as const;
}

function createConfiguredDiscordRoute() {
  const configuredBinding = createConfiguredDiscordBinding();
  return {
    bindingResolution: {
      compiledBinding: {
        accountPattern: "default",
        agentId: "codex",
        binding: {
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "discord",
            peer: {
              id: CHANNEL_ID,
              kind: "channel",
            },
          },
          type: "acp",
        },
        bindingConversationId: CHANNEL_ID,
        channel: "discord",
        provider: {
          compileConfiguredBinding: () => ({ conversationId: CHANNEL_ID }),
          matchInboundConversation: () => ({ conversationId: CHANNEL_ID }),
        },
        target: {
          conversationId: CHANNEL_ID,
        },
        targetFactory: {
          driverId: "acp",
          materialize: () => ({
            record: configuredBinding.record,
            statefulTarget: {
              agentId: configuredBinding.spec.agentId,
              driverId: "acp",
              kind: "stateful",
              sessionKey: configuredBinding.record.targetSessionKey,
            },
          }),
        },
      },
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: CHANNEL_ID,
      },
      match: {
        conversationId: CHANNEL_ID,
      },
      record: configuredBinding.record,
      statefulTarget: {
        agentId: configuredBinding.spec.agentId,
        driverId: "acp",
        kind: "stateful",
        sessionKey: configuredBinding.record.targetSessionKey,
      },
    },
    boundSessionKey: configuredBinding.record.targetSessionKey,
    configuredBinding,
    route: {
      accountId: "default",
      agentId: "codex",
      channel: "discord",
      lastRoutePolicy: "bound",
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
      sessionKey: configuredBinding.record.targetSessionKey,
    },
  } as const;
}

function createBasePreflightParams(overrides?: Record<string, unknown>) {
  const message = createDiscordMessage({
    author: {
      bot: false,
      id: "user-1",
      username: "alice",
    },
    channelId: CHANNEL_ID,
    content: "<@bot-1> hello",
    id: "m-1",
    mentionedUsers: [{ id: "bot-1" }],
  });

  return {
    ...createDiscordPreflightArgs({
      botUserId: "bot-1",
      cfg: DEFAULT_PREFLIGHT_CFG,
      client: createGuildTextClient(CHANNEL_ID),
      data: createGuildEvent({
        author: message.author,
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        message,
      }),
      discordConfig: {
        allowBots: true,
      } as NonNullable<
        import("openclaw/plugin-sdk/config-runtime").OpenClawConfig["channels"]
      >["discord"],
    }),
    discordConfig: {
      allowBots: true,
    } as NonNullable<
      import("openclaw/plugin-sdk/config-runtime").OpenClawConfig["channels"]
    >["discord"],
    ...overrides,
  } satisfies Parameters<typeof preflightDiscordMessage>[0];
}

function createAllowedGuildEntries(requireMention = false) {
  return {
    [GUILD_ID]: {
      channels: {
        [CHANNEL_ID]: {
          enabled: true,
          requireMention,
        },
      },
      id: GUILD_ID,
    },
  };
}

function createHydratedGuildClient(restPayload: Record<string, unknown>) {
  const restGet = vi.fn(async () => restPayload);
  const client = Object.assign(createGuildTextClient(CHANNEL_ID), {
    rest: {
      get: restGet,
    },
  }) as unknown as Parameters<typeof preflightDiscordMessage>[0]["client"];
  return { client, restGet };
}

async function runRestHydrationPreflight(params: {
  messageId: string;
  restPayload: Record<string, unknown>;
}) {
  const message = createDiscordMessage({
    author: {
      bot: false,
      id: "user-1",
      username: "alice",
    },
    channelId: CHANNEL_ID,
    content: "",
    id: params.messageId,
  });
  const { client, restGet } = createHydratedGuildClient(params.restPayload);
  const result = await preflightDiscordMessage(
    createBasePreflightParams({
      client,
      data: createGuildEvent({
        author: message.author,
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        message,
      }),
      guildEntries: createAllowedGuildEntries(false),
    }),
  );
  return { restGet, result };
}

describe("preflightDiscordMessage configured ACP bindings", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    ensureConfiguredBindingRouteReadyMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReturnValue(createConfiguredDiscordRoute());
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
    vi.spyOn(conversationRuntime, "resolveConfiguredBindingRoute").mockImplementation(
      resolveConfiguredBindingRouteMock,
    );
    vi.spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady").mockImplementation(
      ensureConfiguredBindingRouteReadyMock,
    );
  });

  it("does not initialize configured ACP bindings for rejected messages", async () => {
    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        guildEntries: {
          [GUILD_ID]: {
            channels: {
              [CHANNEL_ID]: {
                enabled: false,
              },
            },
            id: GUILD_ID,
          },
        },
      }),
    );

    expect(result).toBeNull();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });

  it("initializes configured ACP bindings only after preflight accepts the message", async () => {
    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        guildEntries: {
          [GUILD_ID]: {
            channels: {
              [CHANNEL_ID]: {
                enabled: true,
                requireMention: false,
              },
            },
            id: GUILD_ID,
          },
        },
      }),
    );

    expect(result).not.toBeNull();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
  });

  it("accepts plain messages in configured ACP-bound channels without a mention", async () => {
    const message = createDiscordMessage({
      author: {
        bot: false,
        id: "user-1",
        username: "alice",
      },
      channelId: CHANNEL_ID,
      content: "hello",
      id: "m-no-mention",
      mentionedUsers: [],
    });

    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        data: createGuildEvent({
          author: message.author,
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          message,
        }),
        guildEntries: createAllowedGuildEntries(false),
      }),
    );

    expect(result).not.toBeNull();
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
  });

  it("hydrates empty guild message payloads from REST before ensuring configured ACP bindings", async () => {
    const { result, restGet } = await runRestHydrationPreflight({
      messageId: "m-rest",
      restPayload: {
        attachments: [],
        author: {
          id: "user-1",
          username: "alice",
        },
        content: "hello from rest",
        embeds: [],
        id: "m-rest",
        mention_everyone: false,
        mention_roles: [],
        mentions: [],
      },
    });

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result?.messageText).toBe("hello from rest");
    expect(result?.data.message.content).toBe("hello from rest");
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
  });

  it("hydrates sticker-only guild message payloads from REST before ensuring configured ACP bindings", async () => {
    const { result, restGet } = await runRestHydrationPreflight({
      messageId: "m-rest-sticker",
      restPayload: {
        attachments: [],
        author: {
          id: "user-1",
          username: "alice",
        },
        content: "",
        embeds: [],
        id: "m-rest-sticker",
        mention_everyone: false,
        mention_roles: [],
        mentions: [],
        sticker_items: [
          {
            id: "sticker-1",
            name: "wave",
          },
        ],
      },
    });

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result?.messageText).toBe("<media:sticker> (1 sticker)");
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
  });
});
