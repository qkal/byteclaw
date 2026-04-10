import { ChannelType } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { preflightDiscordMessage } from "./message-handler.preflight.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
export type DiscordMessageEvent = import("./listeners.js").DiscordMessageEvent;
export type DiscordClient = import("@buape/carbon").Client;

export const DEFAULT_PREFLIGHT_CFG = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
} as OpenClawConfig;

export function createGuildTextClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === channelId) {
        return {
          id: channelId,
          name: "general",
          type: ChannelType.GuildText,
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

export function createGuildEvent(params: {
  channelId: string;
  guildId: string;
  author: import("@buape/carbon").Message["author"];
  message: import("@buape/carbon").Message;
  includeGuildObject?: boolean;
}): DiscordMessageEvent {
  return {
    channel_id: params.channelId,
    guild_id: params.guildId,
    ...(params.includeGuildObject === false
      ? {}
      : {
          guild: {
            id: params.guildId,
            name: "Guild One",
          },
        }),
    author: params.author,
    message: params.message,
  } as unknown as DiscordMessageEvent;
}

export function createDiscordMessage(params: {
  id: string;
  channelId: string;
  content: string;
  author: {
    id: string;
    bot: boolean;
    username?: string;
  };
  mentionedUsers?: { id: string }[];
  mentionedEveryone?: boolean;
  attachments?: Record<string, unknown>[];
}): import("@buape/carbon").Message {
  return {
    attachments: params.attachments ?? [],
    author: params.author,
    channelId: params.channelId,
    content: params.content,
    id: params.id,
    mentionedEveryone: params.mentionedEveryone ?? false,
    mentionedRoles: [],
    mentionedUsers: params.mentionedUsers ?? [],
    timestamp: new Date().toISOString(),
  } as unknown as import("@buape/carbon").Message;
}

export function createDiscordPreflightArgs(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  data: DiscordMessageEvent;
  client: DiscordClient;
  botUserId?: string;
}): Parameters<typeof preflightDiscordMessage>[0] {
  return {
    accountId: "default",
    ackReactionScope: "direct",
    botUserId: params.botUserId ?? "openclaw-bot",
    cfg: params.cfg,
    client: params.client,
    data: params.data,
    discordConfig: params.discordConfig,
    dmEnabled: true,
    groupDmEnabled: true,
    groupPolicy: "open",
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1_000_000,
    replyToMode: "all",
    runtime: {} as import("openclaw/plugin-sdk/runtime-env").RuntimeEnv,
    textLimit: 2000,
    threadBindings: createNoopThreadBindingManager("default"),
    token: "token",
  };
}
