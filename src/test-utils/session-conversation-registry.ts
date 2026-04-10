import { createTestRegistry } from "./channel-plugins.js";

function resolveTelegramSessionConversation(params: { kind: "group" | "channel"; rawId: string }) {
  if (params.kind !== "group") {
    return null;
  }
  const match = params.rawId.match(/^(?<chatId>.+):topic:(?<topicId>[^:]+)$/u);
  if (!match?.groups?.chatId || !match.groups.topicId) {
    return null;
  }
  const { chatId } = match.groups;
  return {
    baseConversationId: chatId,
    id: chatId,
    parentConversationCandidates: [chatId],
    threadId: match.groups.topicId,
  };
}

function resolveFeishuSessionConversation(params: { kind: "group" | "channel"; rawId: string }) {
  if (params.kind !== "group") {
    return null;
  }
  const senderMatch = params.rawId.match(
    /^(?<chatId>[^:]+):topic:(?<topicId>[^:]+):sender:(?<senderId>[^:]+)$/u,
  );
  if (!senderMatch?.groups?.chatId || !senderMatch.groups.topicId || !senderMatch.groups.senderId) {
    return null;
  }
  const { chatId } = senderMatch.groups;
  const { topicId } = senderMatch.groups;
  return {
    baseConversationId: chatId,
    id: params.rawId,
    parentConversationCandidates: [`${chatId}:topic:${topicId}`, chatId],
  };
}

export function createSessionConversationTestRegistry() {
  return createTestRegistry([
    {
      plugin: {
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "discord",
        messaging: {
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        meta: {
          blurb: "Discord test stub.",
          docsPath: "/channels/discord",
          id: "discord",
          label: "Discord",
          selectionLabel: "Discord",
        },
      },
      pluginId: "discord",
      source: "test",
    },
    {
      plugin: {
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "slack",
        messaging: {
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        meta: {
          blurb: "Slack test stub.",
          docsPath: "/channels/slack",
          id: "slack",
          label: "Slack",
          selectionLabel: "Slack",
        },
      },
      pluginId: "slack",
      source: "test",
    },
    {
      plugin: {
        capabilities: { chatTypes: ["direct", "channel", "thread"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "matrix",
        messaging: {
          resolveSessionTarget: ({ id }: { id: string }) => `channel:${id}`,
        },
        meta: {
          blurb: "Matrix test stub.",
          docsPath: "/channels/matrix",
          id: "matrix",
          label: "Matrix",
          selectionLabel: "Matrix",
        },
      },
      pluginId: "matrix",
      source: "test",
    },
    {
      plugin: {
        capabilities: { chatTypes: ["direct", "group", "thread"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "telegram",
        messaging: {
          normalizeTarget: (raw: string) => raw.replace(/^group:/, ""),
          resolveSessionConversation: resolveTelegramSessionConversation,
        },
        meta: {
          blurb: "Telegram test stub.",
          docsPath: "/channels/telegram",
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
        },
      },
      pluginId: "telegram",
      source: "test",
    },
    {
      plugin: {
        capabilities: { chatTypes: ["direct", "group", "thread"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        id: "feishu",
        messaging: {
          normalizeTarget: (raw: string) => raw.replace(/^group:/, ""),
          resolveSessionConversation: resolveFeishuSessionConversation,
        },
        meta: {
          blurb: "Feishu test stub.",
          docsPath: "/channels/feishu",
          id: "feishu",
          label: "Feishu",
          selectionLabel: "Feishu",
        },
      },
      pluginId: "feishu",
      source: "test",
    },
  ]);
}
