import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  type SessionBindingRecord,
  getSessionBindingService,
  registerSessionBindingAdapter,
  __testing as sessionBindingTesting,
} from "../../../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { buildCommandTestParams } from "../commands-spawn.test-harness.js";
import {
  resolveAcpCommandBindingContext,
  resolveAcpCommandConversationId,
  resolveAcpCommandParentConversationId,
} from "./context.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function parseTelegramChatIdForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^telegram:/i, "");
  if (!trimmed) {
    return undefined;
  }
  const topicMatch = /^(.*):topic:\d+$/i.exec(trimmed);
  return (topicMatch?.[1] ?? trimmed).trim() || undefined;
}

function parseDiscordConversationIdForTest(
  targets: (string | undefined | null)[],
): string | undefined {
  for (const rawTarget of targets) {
    const target = rawTarget?.trim();
    if (!target) {
      continue;
    }
    const mentionMatch = /^<#(\d+)>$/.exec(target);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    if (/^channel:/i.test(target)) {
      return target;
    }
  }
  return undefined;
}

function parseDiscordParentChannelFromSessionKeyForTest(raw?: string | null): string | undefined {
  const sessionKey = raw?.trim().toLowerCase() ?? "";
  const match = sessionKey.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? `channel:${match[1]}` : undefined;
}

function parseFeishuTargetIdForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^(chat|group|channel):/i.test(trimmed)) {
    return trimmed.replace(/^(chat|group|channel):/i, "").trim() || undefined;
  }
  return undefined;
}

function parseFeishuDirectConversationIdForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !/^(user|dm):/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.replace(/^(user|dm):/i, "").trim() || undefined;
}

function parseBlueBubblesConversationIdFromTargetForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^bluebubbles:/i, "");
  if (!trimmed) {
    return undefined;
  }
  const prefixed = /^(chat_guid|chat_identifier|chat_id):(.+)$/i.exec(trimmed);
  return (prefixed?.[2] ?? trimmed).trim() || undefined;
}

function parseIMessageConversationIdFromTargetForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^imessage:/i, "");
  if (!trimmed) {
    return undefined;
  }
  const prefixed = /^(chat_guid|chat_identifier|chat_id):(.+)$/i.exec(trimmed);
  return (prefixed?.[2] ?? trimmed).trim() || undefined;
}

function parseLineConversationIdFromTargetForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^line:/i, "");
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^user:/i, "").trim() || undefined;
}

function buildFeishuSenderScopedConversationIdForTest(params: {
  accountId: string;
  parentConversationId: string;
  threadId: string;
  senderId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
}): string | undefined {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return undefined;
  }
  const expectedPrefix = `${params.parentConversationId}:topic:${params.threadId}:sender:${senderId}`;
  for (const candidate of [params.parentSessionKey, params.sessionKey]) {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      continue;
    }
    const match = /feishu:group:(.+)$/.exec(trimmed);
    if (match?.[1]?.endsWith(expectedPrefix)) {
      return match[1];
    }
  }
  if (params.sessionKey) {
    const existing = getSessionBindingService()
      .listBySession(params.sessionKey)
      .find(
        (binding) =>
          binding.conversation.channel === "feishu" &&
          binding.conversation.accountId === params.accountId &&
          binding.conversation.conversationId.endsWith(expectedPrefix),
      );
    if (existing) {
      return existing.conversation.conversationId;
    }
  }
  return undefined;
}

function setMinimalAcpContextRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const chatId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => parseTelegramChatIdForTest(candidate))
                .find(Boolean);
              if (!chatId) {
                return null;
              }
              if (threadId) {
                return {
                  conversationId: `${chatId}:topic:${threadId}`,
                  parentConversationId: chatId,
                };
              }
              if (chatId.startsWith("-")) {
                return null;
              }
              return { conversationId: chatId, parentConversationId: chatId };
            },
          },
        },
        pluginId: "telegram",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
          bindings: {
            resolveCommandConversation: ({
              threadId,
              threadParentId,
              parentSessionKey,
              from,
              chatType,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              threadParentId?: string;
              parentSessionKey?: string;
              from?: string;
              chatType?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              if (threadId) {
                const parentConversationId =
                  (threadParentId?.trim()
                    ? `channel:${threadParentId.trim().replace(/^channel:/i, "")}`
                    : undefined) ??
                  parseDiscordParentChannelFromSessionKeyForTest(parentSessionKey) ??
                  parseDiscordConversationIdForTest([originatingTo, commandTo, fallbackTo]);
                return {
                  conversationId: threadId,
                  ...(parentConversationId && parentConversationId !== threadId
                    ? { parentConversationId }
                    : {}),
                };
              }
              if (chatType === "direct") {
                const directSenderId = from
                  ?.trim()
                  .replace(/^discord:/i, "")
                  .replace(/^user:/i, "");
                if (directSenderId) {
                  return { conversationId: `user:${directSenderId}` };
                }
              }
              const conversationId = parseDiscordConversationIdForTest([
                originatingTo,
                commandTo,
                fallbackTo,
              ]);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "discord",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "feishu", label: "Feishu" }),
          bindings: {
            resolveCommandConversation: ({
              accountId,
              threadId,
              senderId,
              sessionKey,
              parentSessionKey,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              accountId: string;
              threadId?: string;
              senderId?: string;
              sessionKey?: string;
              parentSessionKey?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              if (threadId) {
                const parentConversationId =
                  parseFeishuTargetIdForTest(originatingTo) ??
                  parseFeishuTargetIdForTest(commandTo) ??
                  parseFeishuTargetIdForTest(fallbackTo);
                if (!parentConversationId) {
                  return null;
                }
                const senderScopedConversationId = buildFeishuSenderScopedConversationIdForTest({
                  accountId,
                  parentConversationId,
                  parentSessionKey,
                  senderId,
                  sessionKey,
                  threadId,
                });
                return {
                  conversationId:
                    senderScopedConversationId ?? `${parentConversationId}:topic:${threadId}`,
                  parentConversationId,
                };
              }
              const conversationId =
                parseFeishuDirectConversationIdForTest(originatingTo) ??
                parseFeishuDirectConversationIdForTest(commandTo) ??
                parseFeishuDirectConversationIdForTest(fallbackTo);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "feishu",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "bluebubbles", label: "BlueBubbles" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId =
                parseBlueBubblesConversationIdFromTargetForTest(originatingTo) ??
                parseBlueBubblesConversationIdFromTargetForTest(commandTo) ??
                parseBlueBubblesConversationIdFromTargetForTest(fallbackTo);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "bluebubbles",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "imessage", label: "iMessage" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId =
                parseIMessageConversationIdFromTargetForTest(originatingTo) ??
                parseIMessageConversationIdFromTargetForTest(commandTo) ??
                parseIMessageConversationIdFromTargetForTest(fallbackTo);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "imessage",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "line", label: "LINE" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId =
                parseLineConversationIdFromTargetForTest(originatingTo) ??
                parseLineConversationIdFromTargetForTest(commandTo) ??
                parseLineConversationIdFromTargetForTest(fallbackTo);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "line",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const roomId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^room:/i, ""))
                .find((candidate) => candidate && candidate.length > 0);
              if (!threadId || !roomId) {
                return null;
              }
              return {
                conversationId: threadId,
                parentConversationId: roomId,
              };
            },
          },
        },
        pluginId: "matrix",
        source: "test",
      },
    ]),
  );
}

function registerFeishuBindingAdapterForTest(accountId: string) {
  const bindings: SessionBindingRecord[] = [];
  registerSessionBindingAdapter({
    accountId,
    bind: async (input) => {
      const record: SessionBindingRecord = {
        bindingId: `${input.conversation.channel}:${input.conversation.accountId}:${input.conversation.conversationId}`,
        boundAt: Date.now(),
        conversation: input.conversation,
        status: "active",
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      bindings.push(record);
      return record;
    },
    capabilities: { placements: ["current"] },
    channel: "feishu",
    listBySession: (targetSessionKey) =>
      bindings.filter((binding) => binding.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (binding) =>
          binding.conversation.channel === ref.channel &&
          binding.conversation.accountId === ref.accountId &&
          binding.conversation.conversationId === ref.conversationId,
      ) ?? null,
  });
}

describe("commands-acp context", () => {
  beforeEach(() => {
    setMinimalAcpContextRegistryForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  afterEach(() => {
    setMinimalAcpContextRegistryForTests();
  });

  it("resolves channel/account/thread context from originating fields", () => {
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      AccountId: "work",
      MessageThreadId: "thread-42",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:parent-1",
      Provider: "discord",
      Surface: "discord",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "discord",
      conversationId: "thread-42",
      parentConversationId: "channel:parent-1",
      threadId: "thread-42",
    });
  });

  it("resolves discord DM current conversation ids from direct sender context", () => {
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      AccountId: "work",
      ChatType: "direct",
      From: "discord:U1",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:dm-1",
      Provider: "discord",
      Surface: "discord",
      To: "channel:dm-1",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "discord",
      conversationId: "user:U1",
    });
  });

  it("resolves discord thread parent from ParentSessionKey when targets point at the thread", () => {
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      AccountId: "work",
      MessageThreadId: "thread-42",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:thread-42",
      ParentSessionKey: "agent:codex:discord:channel:parent-9",
      Provider: "discord",
      Surface: "discord",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "discord",
      conversationId: "thread-42",
      parentConversationId: "channel:parent-9",
      threadId: "thread-42",
    });
  });

  it("resolves discord thread parent from native context when ParentSessionKey is absent", () => {
    const params = buildCommandTestParams("/acp sessions", baseCfg, {
      AccountId: "work",
      MessageThreadId: "thread-42",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:thread-42",
      Provider: "discord",
      Surface: "discord",
      ThreadParentId: "parent-11",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "discord",
      conversationId: "thread-42",
      parentConversationId: "channel:parent-11",
      threadId: "thread-42",
    });
  });

  it("falls back to default account and target-derived conversation id", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "slack",
      Provider: "slack",
      Surface: "slack",
      To: "<#123456789>",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "default",
      channel: "slack",
      conversationId: "123456789",
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("123456789");
  });

  it("uses the plugin default account when ACP context omits AccountId", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...createChannelTestPluginBase({
              config: {
                defaultAccountId: () => "work",
                listAccountIds: () => ["default", "work"],
              },
              id: "line",
              label: "LINE",
            }),
            bindings: {
              resolveCommandConversation: ({
                originatingTo,
                commandTo,
                fallbackTo,
              }: {
                originatingTo?: string;
                commandTo?: string;
                fallbackTo?: string;
              }) => {
                const conversationId =
                  parseLineConversationIdFromTargetForTest(originatingTo) ??
                  parseLineConversationIdFromTargetForTest(commandTo) ??
                  parseLineConversationIdFromTargetForTest(fallbackTo);
                return conversationId ? { conversationId } : null;
              },
            },
          },
          pluginId: "line",
          source: "test",
        },
      ]),
    );

    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "line",
      OriginatingTo: "line:user:U1234567890abcdef1234567890abcdef",
      Provider: "line",
      Surface: "line",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "line",
      conversationId: "U1234567890abcdef1234567890abcdef",
      threadId: undefined,
    });
  });

  it("builds canonical telegram topic conversation ids from originating chat + thread", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      MessageThreadId: "42",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-1001234567890",
      Provider: "telegram",
      Surface: "telegram",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "default",
      channel: "telegram",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      threadId: "42",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("-1001234567890:topic:42");
  });

  it("resolves Telegram DM conversation ids from telegram targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:123456789",
      Provider: "telegram",
      Surface: "telegram",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "default",
      channel: "telegram",
      conversationId: "123456789",
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("123456789");
  });

  it("resolves LINE DM conversation ids from raw LINE targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "line",
      OriginatingTo: "U1234567890abcdef1234567890abcdef",
      Provider: "line",
      Surface: "line",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "default",
      channel: "line",
      conversationId: "U1234567890abcdef1234567890abcdef",
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("U1234567890abcdef1234567890abcdef");
  });

  it("resolves LINE conversation ids from prefixed LINE targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      OriginatingChannel: "line",
      OriginatingTo: "line:user:U1234567890abcdef1234567890abcdef",
      Provider: "line",
      Surface: "line",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "line",
      conversationId: "U1234567890abcdef1234567890abcdef",
      threadId: undefined,
    });
  });

  it("resolves LINE conversation ids from canonical line targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      OriginatingChannel: "line",
      OriginatingTo: "line:U1234567890abcdef1234567890abcdef",
      Provider: "line",
      Surface: "line",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "line",
      conversationId: "U1234567890abcdef1234567890abcdef",
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("U1234567890abcdef1234567890abcdef");
  });

  it("resolves Matrix thread context from the current room and thread root", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      MessageThreadId: "$thread-root",
      OriginatingChannel: "matrix",
      OriginatingTo: "room:!room:example.org",
      Provider: "matrix",
      Surface: "matrix",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "matrix",
      conversationId: "$thread-root",
      parentConversationId: "!room:example.org",
      threadId: "$thread-root",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("$thread-root");
    expect(resolveAcpCommandParentConversationId(params)).toBe("!room:example.org");
  });

  it("resolves BlueBubbles DM conversation ids from current targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "bluebubbles",
      OriginatingTo: "bluebubbles:+15555550123",
      Provider: "bluebubbles",
      Surface: "bluebubbles",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "default",
      channel: "bluebubbles",
      conversationId: "+15555550123",
      parentConversationId: undefined,
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("+15555550123");
  });

  it("resolves BlueBubbles group conversation ids from explicit chat targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      OriginatingChannel: "bluebubbles",
      OriginatingTo: "bluebubbles:chat_guid:iMessage;+;chat123",
      Provider: "bluebubbles",
      Surface: "bluebubbles",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "bluebubbles",
      conversationId: "iMessage;+;chat123",
      parentConversationId: undefined,
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("iMessage;+;chat123");
  });

  it("resolves iMessage DM conversation ids from current targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:+15555550123",
      Provider: "imessage",
      Surface: "imessage",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "default",
      channel: "imessage",
      conversationId: "+15555550123",
      parentConversationId: undefined,
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("+15555550123");
  });

  it("resolves iMessage group conversation ids from chat_id targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      OriginatingChannel: "imessage",
      OriginatingTo: "chat_id:12345",
      Provider: "imessage",
      Surface: "imessage",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "imessage",
      conversationId: "12345",
      parentConversationId: undefined,
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("12345");
  });

  it("builds Feishu topic conversation ids from chat target + root message id", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      MessageThreadId: "om_topic_root",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      Provider: "feishu",
      SenderId: "ou_topic_user",
      Surface: "feishu",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "feishu",
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
      threadId: "om_topic_root",
    });
    expect(resolveAcpCommandConversationId(params)).toBe("oc_group_chat:topic:om_topic_root");
  });

  it("builds sender-scoped Feishu topic conversation ids when current session is sender-scoped", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      MessageThreadId: "om_topic_root",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      Provider: "feishu",
      SenderId: "ou_topic_user",
      SessionKey: "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      Surface: "feishu",
    });
    params.sessionKey =
      "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user";

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "feishu",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationId: "oc_group_chat",
      threadId: "om_topic_root",
    });
    expect(resolveAcpCommandConversationId(params)).toBe(
      "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
    );
  });

  it("preserves sender-scoped Feishu topic ids after ACP route takeover via ParentSessionKey", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      MessageThreadId: "om_topic_root",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      ParentSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      Provider: "feishu",
      SenderId: "ou_topic_user",
      Surface: "feishu",
    });
    params.sessionKey = "agent:codex:acp:binding:feishu:work:abc123";

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "feishu",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationId: "oc_group_chat",
      threadId: "om_topic_root",
    });
  });

  it("preserves sender-scoped Feishu topic ids after ACP takeover from the live binding record", async () => {
    registerFeishuBindingAdapterForTest("work");
    await getSessionBindingService().bind({
      conversation: {
        accountId: "work",
        channel: "feishu",
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
        parentConversationId: "oc_group_chat",
      },
      metadata: {
        agentId: "codex",
      },
      placement: "current",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:binding:feishu:work:abc123",
    });

    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      MessageThreadId: "om_topic_root",
      OriginatingChannel: "feishu",
      OriginatingTo: "chat:oc_group_chat",
      Provider: "feishu",
      SenderId: "ou_topic_user",
      Surface: "feishu",
    });
    params.sessionKey = "agent:codex:acp:binding:feishu:work:abc123";

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "feishu",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationId: "oc_group_chat",
      threadId: "om_topic_root",
    });
  });

  it("resolves Feishu DM conversation ids from user targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "feishu",
      OriginatingTo: "user:ou_sender_1",
      Provider: "feishu",
      Surface: "feishu",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "default",
      channel: "feishu",
      conversationId: "ou_sender_1",
      parentConversationId: undefined,
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("ou_sender_1");
  });

  it("resolves Feishu DM conversation ids from user_id fallback targets", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      OriginatingChannel: "feishu",
      OriginatingTo: "user:user_123",
      Provider: "feishu",
      Surface: "feishu",
    });

    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "default",
      channel: "feishu",
      conversationId: "user_123",
      parentConversationId: undefined,
      threadId: undefined,
    });
    expect(resolveAcpCommandConversationId(params)).toBe("user_123");
  });

  it("does not infer a Feishu DM parent conversation id during fallback binding lookup", () => {
    const params = buildCommandTestParams("/acp status", baseCfg, {
      AccountId: "work",
      OriginatingChannel: "feishu",
      OriginatingTo: "user:ou_sender_1",
      Provider: "feishu",
      Surface: "feishu",
    });

    expect(resolveAcpCommandParentConversationId(params)).toBeUndefined();
    expect(resolveAcpCommandBindingContext(params)).toEqual({
      accountId: "work",
      channel: "feishu",
      conversationId: "ou_sender_1",
      parentConversationId: undefined,
      threadId: undefined,
    });
  });
});
