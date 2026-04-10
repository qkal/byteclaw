import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export async function createBaseDiscordMessageContext(
  overrides: Record<string, unknown> = {},
): Promise<DiscordMessagePreflightContext> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-"));
  const storePath = path.join(dir, "sessions.json");
  return {
    accountId: "default",
    ackReactionScope: "group-mentions",
    author: {
      discriminator: "0",
      globalName: "Alice",
      id: "U1",
      username: "alice",
    },
    baseSessionKey: "agent:main:discord:guild:g1",
    baseText: "hi",
    canDetectMention: true,
    cfg: { messages: { ackReaction: "👀" }, session: { store: storePath } },
    channelConfig: null,
    channelInfo: { name: "general" },
    channelName: "general",
    client: { rest: {} },
    commandAuthorized: true,
    data: { guild: { id: "g1", name: "Guild" } },
    discordConfig: {},
    displayChannelSlug: "general",
    effectiveWasMentioned: true,
    groupPolicy: "open",
    guildHistories: new Map(),
    guildInfo: null,
    guildSlug: "guild",
    historyLimit: 0,
    isDirectMessage: false,
    isGroupDm: false,
    isGuildMessage: true,
    mediaMaxBytes: 1024,
    message: {
      attachments: [],
      channelId: "c1",
      id: "m1",
      timestamp: new Date().toISOString(),
    },
    messageChannelId: "c1",
    messageText: "hi",
    replyToMode: "off",
    route: {
      accountId: "default",
      agentId: "main",
      channel: "discord",
      mainSessionKey: "agent:main:main",
      sessionKey: "agent:main:discord:guild:g1",
    },
    runtime: { error: () => {}, log: () => {} },
    sender: { label: "user" },
    shouldBypassMention: false,
    shouldRequireMention: true,
    textLimit: 4000,
    threadBindings: createNoopThreadBindingManager("default"),
    threadChannel: null,
    threadName: undefined,
    threadParentId: undefined,
    threadParentName: undefined,
    threadParentType: undefined,
    token: "token",
    wasMentioned: false,
    ...overrides,
  } as unknown as DiscordMessagePreflightContext;
}

export function createDiscordDirectMessageContextOverrides(): Record<string, unknown> {
  return {
    baseSessionKey: "agent:main:discord:direct:u1",
    canDetectMention: false,
    channelInfo: null,
    channelName: undefined,
    data: { guild: null },
    displayChannelSlug: "",
    effectiveWasMentioned: false,
    guildInfo: null,
    guildSlug: "",
    isDirectMessage: true,
    isGroupDm: false,
    isGuildMessage: false,
    route: {
      accountId: "default",
      agentId: "main",
      channel: "discord",
      mainSessionKey: "agent:main:main",
      sessionKey: "agent:main:discord:direct:u1",
    },
    shouldRequireMention: false,
  };
}
