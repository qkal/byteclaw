import type { Client } from "@buape/carbon";
import { ChannelType, MessageType } from "@buape/carbon";
import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { vi } from "vitest";
import {
  TOOL_RESULT_SESSION_STORE_PATH,
  dispatchMock,
  installDiscordToolResultHarnessSpies,
  loadConfigMock,
  readAllowFromStoreMock,
  sendMock,
  updateLastRouteMock,
  upsertPairingRequestMock,
} from "./monitor.tool-result.test-harness.js";
import { createDiscordMessageHandler } from "./monitor/message-handler.js";
import { __resetDiscordChannelInfoCacheForTest } from "./monitor/message-utils.js";
import { createNoopThreadBindingManager } from "./monitor/thread-bindings.js";

export type Config = ReturnType<typeof loadConfig>;

export const BASE_CFG: Config = {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-5" },
      workspace: "/tmp/openclaw",
    },
  },
  messages: {
    inbound: { debounceMs: 0 },
  },
  session: { store: TOOL_RESULT_SESSION_STORE_PATH },
};

export const CATEGORY_GUILD_CFG = {
  ...BASE_CFG,
  channels: {
    discord: {
      dm: { enabled: true, policy: "open" },
      guilds: {
        "*": {
          channels: { c1: { enabled: true } },
          requireMention: false,
        },
      },
    },
  },
} satisfies Config;

export function resetDiscordToolResultHarness() {
  installDiscordToolResultHarnessSpies();
  __resetDiscordChannelInfoCacheForTest();
  sendMock.mockClear().mockResolvedValue(undefined);
  updateLastRouteMock.mockClear();
  dispatchMock.mockClear().mockImplementation(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "hi" });
    return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: true };
  });
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
  loadConfigMock.mockClear().mockReturnValue(BASE_CFG);
}

export function createHandlerBaseConfig(
  cfg: Config,
  runtimeError?: (err: unknown) => void,
): Parameters<typeof createDiscordMessageHandler>[0] {
  return {
    accountId: "default",
    botUserId: "bot-id",
    cfg,
    discordConfig: cfg.channels?.discord,
    dmEnabled: true,
    groupDmEnabled: false,
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    replyToMode: "off",
    runtime: {
      error: runtimeError ?? vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
      log: vi.fn(),
    },
    textLimit: 2000,
    threadBindings: createNoopThreadBindingManager("default"),
    token: "token",
  };
}

export async function createDmHandler(params: {
  cfg: Config;
  runtimeError?: (err: unknown) => void;
}) {
  loadConfigMock.mockReturnValue(params.cfg);
  return createDiscordMessageHandler(createHandlerBaseConfig(params.cfg, params.runtimeError));
}

export async function createGuildHandler(params: {
  cfg: Config;
  guildEntries?: Parameters<typeof createDiscordMessageHandler>[0]["guildEntries"];
  runtimeError?: (err: unknown) => void;
}) {
  loadConfigMock.mockReturnValue(params.cfg);
  return createDiscordMessageHandler({
    ...createHandlerBaseConfig(params.cfg, params.runtimeError),
    guildEntries:
      params.guildEntries ??
      (params.cfg.channels?.discord?.guilds as Parameters<
        typeof createDiscordMessageHandler
      >[0]["guildEntries"]),
  });
}

export function createDmClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      name: "dm",
      type: ChannelType.DM,
    }),
  } as unknown as Client;
}

export async function createCategoryGuildHandler(runtimeError?: (err: unknown) => void) {
  return createGuildHandler({
    cfg: CATEGORY_GUILD_CFG,
    guildEntries: {
      "*": { channels: { c1: { enabled: true } }, requireMention: false },
    },
    runtimeError,
  });
}

export function createCategoryGuildClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      name: "general",
      parentId: "category-1",
      type: ChannelType.GuildText,
    }),
    rest: { get: vi.fn() },
  } as unknown as Client;
}

export function createCategoryGuildEvent(params: {
  messageId: string;
  timestamp?: string;
  author: Record<string, unknown>;
}) {
  return {
    author: params.author,
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
    member: { displayName: "Ada" },
    message: {
      attachments: [],
      author: params.author,
      channelId: "c1",
      content: "hello",
      embeds: [],
      id: params.messageId,
      mentionedEveryone: false,
      mentionedRoles: [],
      mentionedUsers: [],
      timestamp: params.timestamp ?? new Date().toISOString(),
      type: MessageType.Default,
    },
  };
}

export function createGuildTextClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      id: "c1",
      name: "general",
      type: ChannelType.GuildText,
    }),
    rest: { get: vi.fn() },
  } as unknown as Client;
}

export function createGuildMessageEvent(params: {
  messageId: string;
  content: string;
  messagePatch?: Record<string, unknown>;
  eventPatch?: Record<string, unknown>;
}) {
  const messageBase = {
    attachments: [],
    embeds: [],
    mentionedEveryone: false,
    mentionedRoles: [],
    mentionedUsers: [],
    timestamp: new Date().toISOString(),
    type: MessageType.Default,
  };
  return {
    author: { bot: false, id: "u1", username: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
    member: { nickname: "Ada" },
    message: {
      id: params.messageId,
      content: params.content,
      channelId: "c1",
      ...messageBase,
      author: { bot: false, id: "u1", username: "Ada" },
      ...params.messagePatch,
    },
    ...params.eventPatch,
  };
}

export function createThreadChannel(params: { includeStarter?: boolean; type?: ChannelType } = {}) {
  return {
    id: "t1",
    isThread: () => true,
    name: "thread-name",
    parent: {
      id: params.type === ChannelType.PublicThread ? "forum-1" : "p1",
      name: params.type === ChannelType.PublicThread ? "support" : "general",
    },
    parentId: params.type === ChannelType.PublicThread ? "forum-1" : "p1",
    type: params.type ?? ChannelType.PublicThread,
    ...(params.includeStarter
      ? {
          fetchStarterMessage: async () => ({
            author: { tag: "Alice#1", username: "Alice" },
            content: "starter message",
            createdTimestamp: Date.now(),
          }),
        }
      : {}),
  };
}

export function createThreadClient(
  params: {
    fetchChannel?: ReturnType<typeof vi.fn>;
    restGet?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    fetchChannel:
      params.fetchChannel ??
      vi
        .fn()
        .mockResolvedValueOnce({
          id: "t1",
          name: "thread-name",
          ownerId: "owner-1",
          parentId: "p1",
          type: ChannelType.PublicThread,
        })
        .mockResolvedValueOnce({
          id: "p1",
          name: "general",
          type: ChannelType.GuildText,
        }),
    rest: {
      get:
        params.restGet ??
        vi.fn().mockResolvedValue({
          author: { discriminator: "0001", id: "u1", username: "Alice" },
          content: "starter message",
          timestamp: new Date().toISOString(),
        }),
    },
  } as unknown as Client;
}

export function createThreadEvent(messageId: string, channelId = "t1") {
  return {
    author: { bot: false, id: "u1", username: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
    member: { nickname: "Ada" },
    message: {
      attachments: [],
      author: { bot: false, id: "u1", username: "Ada" },
      channelId,
      content: "thread hello",
      embeds: [],
      id: messageId,
      mentionedEveryone: false,
      mentionedRoles: [],
      mentionedUsers: [],
      timestamp: new Date().toISOString(),
      type: MessageType.Default,
    },
  };
}

export function createMentionRequiredGuildConfig(overrides?: Partial<Config>): Config {
  return {
    ...BASE_CFG,
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
        groupPolicy: "open",
        guilds: {
          "*": {
            channels: { c1: { enabled: true } },
            requireMention: true,
          },
        },
      },
    },
    ...overrides,
  };
}

export function captureNextDispatchCtx<
  T extends {
    SessionKey?: string;
    ParentSessionKey?: string;
    ThreadStarterBody?: string;
    ThreadLabel?: string;
    WasMentioned?: boolean;
  },
>(): () => T | undefined {
  let capturedCtx: T | undefined;
  dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
    capturedCtx = ctx as T;
    dispatcher.sendFinalReply({ text: "hi" });
    return { counts: { final: 1 }, queuedFinal: true };
  });
  return () => capturedCtx;
}
