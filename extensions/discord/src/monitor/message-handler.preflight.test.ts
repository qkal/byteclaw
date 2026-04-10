import { ChannelType } from "@buape/carbon";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());
const resolveDiscordDmCommandAccessMock = vi.hoisted(() => vi.fn());
const handleDiscordDmCommandDecisionMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./preflight-audio.runtime.js", () => ({
  transcribeFirstAudio: transcribeFirstAudioMock,
}));
vi.mock("./dm-command-auth.js", () => ({
  resolveDiscordDmCommandAccess: resolveDiscordDmCommandAccessMock,
}));
vi.mock("./dm-command-decision.js", () => ({
  handleDiscordDmCommandDecision: handleDiscordDmCommandDecisionMock,
}));
import {
  __testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";
let preflightDiscordMessage: typeof import("./message-handler.preflight.js").preflightDiscordMessage;
let resolvePreflightMentionRequirement: typeof import("./message-handler.preflight.js").resolvePreflightMentionRequirement;
let shouldIgnoreBoundThreadWebhookMessage: typeof import("./message-handler.preflight.js").shouldIgnoreBoundThreadWebhookMessage;
let threadBindingTesting: typeof import("./thread-bindings.js").__testing;
let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;

beforeAll(async () => {
  ({
    preflightDiscordMessage,
    resolvePreflightMentionRequirement,
    shouldIgnoreBoundThreadWebhookMessage,
  } = await import("./message-handler.preflight.js"));
  ({ __testing: threadBindingTesting, createThreadBindingManager } =
    await import("./thread-bindings.js"));
});

function createThreadBinding(
  overrides?: Partial<import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord>,
) {
  return {
    bindingId: "default:thread-1",
    boundAt: 1,
    conversation: {
      accountId: "default",
      channel: "discord",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    metadata: {
      agentId: "main",
      boundBy: "test",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    },
    status: "active",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child-1",
    ...overrides,
  } satisfies import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord;
}

function createPreflightArgs(params: {
  cfg: import("openclaw/plugin-sdk/config-runtime").OpenClawConfig;
  discordConfig: DiscordConfig;
  data: DiscordMessageEvent;
  client: DiscordClient;
}): Parameters<typeof preflightDiscordMessage>[0] {
  return createDiscordPreflightArgs(params);
}

function createThreadClient(params: { threadId: string; parentId: string }): DiscordClient {
  return {
    fetchChannel: async (channelId: string) => {
      if (channelId === params.threadId) {
        return {
          id: params.threadId,
          name: "focus",
          ownerId: "owner-1",
          parentId: params.parentId,
          type: ChannelType.PublicThread,
        };
      }
      if (channelId === params.parentId) {
        return {
          id: params.parentId,
          name: "general",
          type: ChannelType.GuildText,
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

function createDmClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === channelId) {
        return {
          id: channelId,
          type: ChannelType.DM,
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

async function runThreadBoundPreflight(params: {
  threadId: string;
  parentId: string;
  message: import("@buape/carbon").Message;
  threadBinding: import("openclaw/plugin-sdk/conversation-runtime").SessionBindingRecord;
  discordConfig: DiscordConfig;
  registerBindingAdapter?: boolean;
}) {
  if (params.registerBindingAdapter) {
    registerSessionBindingAdapter({
      accountId: "default",
      channel: "discord",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === params.threadId ? params.threadBinding : null,
    });
  }

  const client = createThreadClient({
    parentId: params.parentId,
    threadId: params.threadId,
  });

  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      client,
      data: createGuildEvent({
        author: params.message.author,
        channelId: params.threadId,
        guildId: "guild-1",
        message: params.message,
      }),
      discordConfig: params.discordConfig,
    }),
    threadBindings: {
      getByThreadId: (id: string) => (id === params.threadId ? params.threadBinding : undefined),
    } as import("./thread-bindings.js").ThreadBindingManager,
  });
}

async function runGuildPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("@buape/carbon").Message;
  discordConfig: DiscordConfig;
  cfg?: import("openclaw/plugin-sdk/config-runtime").OpenClawConfig;
  guildEntries?: Parameters<typeof preflightDiscordMessage>[0]["guildEntries"];
  includeGuildObject?: boolean;
}) {
  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: params.cfg ?? DEFAULT_PREFLIGHT_CFG,
      client: createGuildTextClient(params.channelId),
      data: createGuildEvent({
        author: params.message.author,
        channelId: params.channelId,
        guildId: params.guildId,
        includeGuildObject: params.includeGuildObject,
        message: params.message,
      }),
      discordConfig: params.discordConfig,
    }),
    guildEntries: params.guildEntries,
  });
}

async function runDmPreflight(params: {
  channelId: string;
  message: import("@buape/carbon").Message;
  discordConfig: DiscordConfig;
}) {
  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      client: createDmClient(params.channelId),
      data: {
        author: params.message.author,
        channel_id: params.channelId,
        message: params.message,
      } as DiscordMessageEvent,
      discordConfig: params.discordConfig,
    }),
  });
}

async function runMentionOnlyBotPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("@buape/carbon").Message;
}) {
  return runGuildPreflight({
    channelId: params.channelId,
    discordConfig: {
      allowBots: "mentions",
    } as DiscordConfig,
    guildId: params.guildId,
    message: params.message,
  });
}

async function runIgnoreOtherMentionsPreflight(params: {
  channelId: string;
  guildId: string;
  message: import("@buape/carbon").Message;
}) {
  return runGuildPreflight({
    channelId: params.channelId,
    discordConfig: {} as DiscordConfig,
    guildEntries: {
      [params.guildId]: {
        ignoreOtherMentions: true,
        requireMention: false,
      },
    },
    guildId: params.guildId,
    message: params.message,
  });
}

describe("resolvePreflightMentionRequirement", () => {
  it("requires mention when config requires mention and thread is not bound", () => {
    expect(
      resolvePreflightMentionRequirement({
        bypassMentionRequirement: false,
        shouldRequireMention: true,
      }),
    ).toBe(true);
  });

  it("disables mention requirement when the route explicitly bypasses mentions", () => {
    expect(
      resolvePreflightMentionRequirement({
        bypassMentionRequirement: true,
        shouldRequireMention: true,
      }),
    ).toBe(false);
  });

  it("keeps mention requirement disabled when config already disables it", () => {
    expect(
      resolvePreflightMentionRequirement({
        bypassMentionRequirement: false,
        shouldRequireMention: false,
      }),
    ).toBe(false);
  });
});

describe("preflightDiscordMessage", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    transcribeFirstAudioMock.mockReset();
    resolveDiscordDmCommandAccessMock.mockReset();
    resolveDiscordDmCommandAccessMock.mockResolvedValue({
      allowMatch: { allowed: true, matchedBy: "allowFrom", value: "123" },
      commandAuthorized: true,
      decision: "allow",
    });
    handleDiscordDmCommandDecisionMock.mockReset();
    handleDiscordDmCommandDecisionMock.mockResolvedValue(undefined);
  });

  it("drops bound-thread bot system messages to prevent ACP self-loop", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-system-1";
    const parentId = "channel-parent-1";
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "OpenClaw",
      },
      channelId: threadId,
      content:
        "⚙️ codex-acp session active (auto-unfocus in 24h). Messages here go directly to this session.",
      id: "m-system-1",
    });

    const result = await runThreadBoundPreflight({
      discordConfig: {
        allowBots: true,
      } as DiscordConfig,
      message,
      parentId,
      threadBinding,
      threadId,
    });

    expect(result).toBeNull();
  });

  it("restores direct-message bindings by user target instead of DM channel id", async () => {
    registerSessionBindingAdapter({
      accountId: "default",
      channel: "discord",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "user:user-1"
          ? createThreadBinding({
              conversation: {
                accountId: "default",
                channel: "discord",
                conversationId: "user:user-1",
              },
              metadata: {
                pluginBindingOwner: "plugin",
                pluginId: "openclaw-codex-app-server",
                pluginRoot: "/Users/huntharo/github/openclaw-app-server",
              },
            })
          : null,
    });

    const result = await runDmPreflight({
      channelId: "dm-channel-1",
      discordConfig: {
        allowBots: true,
        dmPolicy: "open",
      } as DiscordConfig,
      message: createDiscordMessage({
        author: {
          bot: false,
          id: "user-1",
          username: "alice",
        },
        channelId: "dm-channel-1",
        content: "who are you",
        id: "m-dm-1",
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.threadBinding).toMatchObject({
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "user:user-1",
      },
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
      },
    });
  });

  it("falls back to the default discord account for omitted-account dm authorization", async () => {
    const message = createDiscordMessage({
      author: {
        bot: false,
        id: "user-1",
        username: "alice",
      },
      channelId: "dm-channel-default-account",
      content: "who are you",
      id: "m-dm-default-account",
    });

    await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          channels: {
            discord: {
              accounts: {
                default: {
                  token: "token-default",
                },
                work: {
                  token: "token-work",
                },
              },
              defaultAccount: "work",
            },
          },
        },
        client: createDmClient("dm-channel-default-account"),
        data: {
          author: message.author,
          channel_id: "dm-channel-default-account",
          message,
        } as DiscordMessageEvent,
        discordConfig: {
          defaultAccount: "work",
          dmPolicy: "allowlist",
        } as DiscordConfig,
      }),
    });

    expect(resolveDiscordDmCommandAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("keeps bound-thread regular bot messages flowing when allowBots=true", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-bot-regular-1";
    const parentId = "channel-parent-regular-1";
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      channelId: threadId,
      content: "here is tool output chunk",
      id: "m-bot-regular-1",
    });

    const result = await runThreadBoundPreflight({
      discordConfig: {
        allowBots: true,
      } as DiscordConfig,
      message,
      parentId,
      registerBindingAdapter: true,
      threadBinding,
      threadId,
    });

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe(threadBinding.targetSessionKey);
  });

  it("drops hydrated bound-thread webhook echoes after fetching an empty payload", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-webhook-hydrated-1";
    const parentId = "channel-parent-webhook-hydrated-1";
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      channelId: threadId,
      content: "",
      id: "m-webhook-hydrated-1",
    });
    const restGet = vi.fn(async () => ({
      attachments: [],
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      content: "webhook relay",
      embeds: [],
      id: message.id,
      mention_everyone: false,
      mention_roles: [],
      mentions: [],
      webhook_id: "wh-1",
    }));
    const client = Object.assign(createThreadClient({ parentId, threadId }), {
      rest: {
        get: restGet,
      },
    }) as unknown as DiscordClient;

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        client,
        data: createGuildEvent({
          author: message.author,
          channelId: threadId,
          guildId: "guild-1",
          message,
        }),
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
      }),
      threadBindings: {
        getByThreadId: (id: string) => (id === threadId ? threadBinding : undefined),
      } as import("./thread-bindings.js").ThreadBindingManager,
    });

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("bypasses mention gating in bound threads for allowed bot senders", async () => {
    const threadBinding = createThreadBinding();
    const threadId = "thread-bot-focus";
    const parentId = "channel-parent-focus";
    const client = createThreadClient({ parentId, threadId });
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      channelId: threadId,
      content: "relay message without mention",
      id: "m-bot-1",
    });

    registerSessionBindingAdapter({
      accountId: "default",
      channel: "discord",
      listBySession: () => [],
      resolveByConversation: (ref) => (ref.conversationId === threadId ? threadBinding : null),
    });

    const result = await preflightDiscordMessage(
      createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
        } as import("openclaw/plugin-sdk/config-runtime").OpenClawConfig,
        client,
        data: createGuildEvent({
          author: message.author,
          channelId: threadId,
          guildId: "guild-1",
          message,
        }),
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe(threadBinding.targetSessionKey);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("drops bot messages without mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-mentions-off";
    const guildId = "guild-bot-mentions-off";
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      channelId,
      content: "relay chatter",
      id: "m-bot-mentions-off",
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).toBeNull();
  });

  it("allows bot messages with explicit mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-mentions-on";
    const guildId = "guild-bot-mentions-on";
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      channelId,
      content: "hi <@openclaw-bot>",
      id: "m-bot-mentions-on",
      mentionedUsers: [{ id: "openclaw-bot" }],
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).not.toBeNull();
  });

  it("still drops bot control commands without a real mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-command-no-mention";
    const guildId = "guild-bot-command-no-mention";
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      channelId,
      content: "/new incident room",
      id: "m-bot-command-no-mention",
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).toBeNull();
  });

  it("still allows bot control commands with an explicit mention when allowBots=mentions", async () => {
    const channelId = "channel-bot-command-with-mention";
    const guildId = "guild-bot-command-with-mention";
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      channelId,
      content: "<@openclaw-bot> /new incident room",
      id: "m-bot-command-with-mention",
      mentionedUsers: [{ id: "openclaw-bot" }],
    });

    const result = await runMentionOnlyBotPreflight({ channelId, guildId, message });

    expect(result).not.toBeNull();
  });

  it("treats @everyone as a mention when requireMention is true", async () => {
    const channelId = "channel-everyone-mention";
    const guildId = "guild-everyone-mention";
    const message = createDiscordMessage({
      author: {
        bot: false,
        id: "user-1",
        username: "Peter",
      },
      channelId,
      content: "@everyone standup time!",
      id: "m-everyone-mention",
      mentionedEveryone: true,
    });

    const result = await runGuildPreflight({
      channelId,
      discordConfig: {
        botId: "openclaw-bot",
      } as DiscordConfig,
      guildEntries: {
        [guildId]: {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
            },
          },
        },
      },
      guildId,
      message,
    });

    expect(result).not.toBeNull();
    expect(result?.shouldRequireMention).toBe(true);
    expect(result?.wasMentioned).toBe(true);
  });

  it("accepts allowlisted guild messages when guild object is missing", async () => {
    const message = createDiscordMessage({
      author: {
        bot: false,
        id: "user-1",
        username: "Peter",
      },
      channelId: "ch-1",
      content: "hello from maintainers",
      id: "m-guild-id-only",
    });

    const result = await runGuildPreflight({
      channelId: "ch-1",
      discordConfig: {} as DiscordConfig,
      guildEntries: {
        "guild-1": {
          channels: {
            "ch-1": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
      guildId: "guild-1",
      includeGuildObject: false,
      message,
    });

    expect(result).not.toBeNull();
    expect(result?.guildInfo?.id).toBe("guild-1");
    expect(result?.channelConfig?.allowed).toBe(true);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("inherits parent thread allowlist when guild object is missing", async () => {
    const threadId = "thread-1";
    const parentId = "parent-1";
    const message = createDiscordMessage({
      author: {
        bot: false,
        id: "user-1",
        username: "Peter",
      },
      channelId: threadId,
      content: "thread hello",
      id: "m-thread-id-only",
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        client: createThreadClient({
          parentId,
          threadId,
        }),
        data: createGuildEvent({
          author: message.author,
          channelId: threadId,
          guildId: "guild-1",
          includeGuildObject: false,
          message,
        }),
        discordConfig: {} as DiscordConfig,
      }),
      guildEntries: {
        "guild-1": {
          channels: {
            [parentId]: {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.guildInfo?.id).toBe("guild-1");
    expect(result?.threadParentId).toBe(parentId);
    expect(result?.channelConfig?.allowed).toBe(true);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("drops guild messages that mention another user when ignoreOtherMentions=true", async () => {
    const channelId = "channel-other-mention-1";
    const guildId = "guild-other-mention-1";
    const message = createDiscordMessage({
      author: {
        bot: false,
        id: "user-1",
        username: "Alice",
      },
      channelId,
      content: "hello <@999>",
      id: "m-other-mention-1",
      mentionedUsers: [{ id: "999" }],
    });

    const result = await runIgnoreOtherMentionsPreflight({ channelId, guildId, message });

    expect(result).toBeNull();
  });

  it("does not drop @everyone messages when ignoreOtherMentions=true", async () => {
    const channelId = "channel-other-mention-everyone";
    const guildId = "guild-other-mention-everyone";
    const message = createDiscordMessage({
      author: {
        bot: false,
        id: "user-1",
        username: "Alice",
      },
      channelId,
      content: "@everyone heads up",
      id: "m-other-mention-everyone",
      mentionedEveryone: true,
    });

    const result = await runIgnoreOtherMentionsPreflight({ channelId, guildId, message });

    expect(result).not.toBeNull();
    expect(result?.hasAnyMention).toBe(true);
  });

  it("ignores bot-sent @everyone mentions for detection", async () => {
    const channelId = "channel-everyone-1";
    const guildId = "guild-everyone-1";
    const client = createGuildTextClient(channelId);
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-1",
        username: "Relay",
      },
      channelId,
      content: "@everyone heads up",
      id: "m-everyone-1",
      mentionedEveryone: true,
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        client,
        data: createGuildEvent({
          author: message.author,
          channelId,
          guildId,
          message,
        }),
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
      }),
      guildEntries: {
        [guildId]: {
          requireMention: false,
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.hasAnyMention).toBe(false);
  });

  it("does not treat bot-sent @everyone as wasMentioned", async () => {
    const channelId = "channel-everyone-2";
    const guildId = "guild-everyone-2";
    const client = createGuildTextClient(channelId);
    const message = createDiscordMessage({
      author: {
        bot: true,
        id: "relay-bot-2",
        username: "RelayBot",
      },
      channelId,
      content: "@everyone relay message",
      id: "m-everyone-2",
      mentionedEveryone: true,
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: DEFAULT_PREFLIGHT_CFG,
        client,
        data: createGuildEvent({
          author: message.author,
          channelId,
          guildId,
          message,
        }),
        discordConfig: {
          allowBots: true,
        } as DiscordConfig,
      }),
      guildEntries: {
        [guildId]: {
          requireMention: false,
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result?.wasMentioned).toBe(false);
  });

  it("uses attachment content_type for guild audio preflight mention detection", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hey openclaw");

    const channelId = "channel-audio-1";
    const client = createGuildTextClient(channelId);

    const message = createDiscordMessage({
      attachments: [
        {
          content_type: "audio/ogg",
          filename: "voice.ogg",
          id: "att-1",
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
        },
      ],
      author: {
        bot: false,
        id: "user-1",
        username: "Alice",
      },
      channelId,
      content: "",
      id: "m-audio-1",
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          messages: {
            groupChat: {
              mentionPatterns: ["openclaw"],
            },
          },
        } as import("openclaw/plugin-sdk/config-runtime").OpenClawConfig,
        client,
        data: createGuildEvent({
          author: message.author,
          channelId,
          guildId: "guild-1",
          message,
        }),
        discordConfig: {} as DiscordConfig,
      }),
      guildEntries: {
        "guild-1": {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
            },
          },
        },
      },
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          MediaTypes: ["audio/ogg"],
          MediaUrls: ["https://cdn.discordapp.com/attachments/voice.ogg"],
        }),
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.wasMentioned).toBe(true);
  });

  it("does not transcribe guild audio from unauthorized members", async () => {
    const channelId = "channel-audio-unauthorized-1";
    const guildId = "guild-audio-unauthorized-1";
    const client = createGuildTextClient(channelId);

    const message = createDiscordMessage({
      attachments: [
        {
          content_type: "audio/ogg",
          filename: "voice.ogg",
          id: "att-1",
          url: "https://cdn.discordapp.com/attachments/voice.ogg",
        },
      ],
      author: {
        bot: false,
        id: "user-2",
        username: "Mallory",
      },
      channelId,
      content: "",
      id: "m-audio-unauthorized-1",
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          messages: {
            groupChat: {
              mentionPatterns: ["openclaw"],
            },
          },
        } as import("openclaw/plugin-sdk/config-runtime").OpenClawConfig,
        client,
        data: createGuildEvent({
          author: message.author,
          channelId,
          guildId,
          message,
        }),
        discordConfig: {} as DiscordConfig,
      }),
      guildEntries: {
        [guildId]: {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
              users: ["user-1"],
            },
          },
        },
      },
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("drops guild message without mention when channel has configuredBinding and requireMention: true", async () => {
    const conversationRuntime = await import("openclaw/plugin-sdk/conversation-runtime");
    const channelId = "ch-binding-1";
    const bindingRoute = {
      bindingResolution: {
        record: {
          targetKind: "session",
          targetSessionKey: "agent:main:acp:binding:discord:default:abc",
        },
      } as never,
      boundAgentId: "main",
      boundSessionKey: "agent:main:acp:binding:discord:default:abc",
      route: { agentId: "main", matchedBy: "binding.channel" } as never,
    };
    const routeSpy = vi
      .spyOn(conversationRuntime, "resolveConfiguredBindingRoute")
      .mockReturnValue(bindingRoute);
    const ensureSpy = vi
      .spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady")
      .mockResolvedValue({ ok: true });

    try {
      const result = await runGuildPreflight({
        channelId,
        discordConfig: {} as DiscordConfig,
        guildEntries: {
          "guild-1": { channels: { [channelId]: { enabled: true, requireMention: true } } },
        },
        guildId: "guild-1",
        message: createDiscordMessage({
          author: { bot: false, id: "user-1", username: "alice" },
          channelId,
          content: "hello without mention",
          id: "m-binding-1",
        }),
      });
      expect(result).toBeNull();
    } finally {
      routeSpy.mockRestore();
      ensureSpy.mockRestore();
    }
  });

  it("allows guild message with mention when channel has configuredBinding and requireMention: true", async () => {
    const conversationRuntime = await import("openclaw/plugin-sdk/conversation-runtime");
    const channelId = "ch-binding-2";
    const bindingRoute = {
      bindingResolution: {
        record: {
          targetKind: "session",
          targetSessionKey: "agent:main:acp:binding:discord:default:def",
        },
      } as never,
      boundAgentId: "main",
      boundSessionKey: "agent:main:acp:binding:discord:default:def",
      route: { agentId: "main", matchedBy: "binding.channel" } as never,
    };
    const routeSpy = vi
      .spyOn(conversationRuntime, "resolveConfiguredBindingRoute")
      .mockReturnValue(bindingRoute);
    const ensureSpy = vi
      .spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady")
      .mockResolvedValue({ ok: true });

    try {
      const result = await runGuildPreflight({
        channelId,
        discordConfig: {} as DiscordConfig,
        guildEntries: {
          "guild-1": { channels: { [channelId]: { enabled: true, requireMention: true } } },
        },
        guildId: "guild-1",
        message: createDiscordMessage({
          author: { bot: false, id: "user-1", username: "alice" },
          channelId,
          content: "hello <@openclaw-bot>",
          id: "m-binding-2",
          mentionedUsers: [{ id: "openclaw-bot" }],
        }),
      });
      expect(result).not.toBeNull();
    } finally {
      routeSpy.mockRestore();
      ensureSpy.mockRestore();
    }
  });
});

describe("shouldIgnoreBoundThreadWebhookMessage", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    threadBindingTesting.resetThreadBindingsForTests();
  });

  it("returns true when inbound webhook id matches the bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        threadBinding: createThreadBinding(),
        webhookId: "wh-1",
      }),
    ).toBe(true);
  });

  it("returns false when webhook ids differ", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        threadBinding: createThreadBinding(),
        webhookId: "wh-other",
      }),
    ).toBe(false);
  });

  it("returns false when there is no bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        threadBinding: createThreadBinding({
          metadata: {
            webhookId: undefined,
          },
        }),
        webhookId: "wh-1",
      }),
    ).toBe(false);
  });

  it("returns true for recently unbound thread webhook echoes", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      enableSweeper: false,
      persist: false,
    });
    const binding = await manager.bindTarget({
      agentId: "main",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      threadId: "thread-1",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    expect(binding).not.toBeNull();

    manager.unbindThread({
      sendFarewell: false,
      threadId: "thread-1",
    });

    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        accountId: "default",
        threadId: "thread-1",
        webhookId: "wh-1",
      }),
    ).toBe(true);
  });
});
