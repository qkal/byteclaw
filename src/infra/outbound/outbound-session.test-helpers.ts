import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
} from "../../plugin-sdk/core.js";
import {
  type RoutePeer,
  buildOutboundBaseSessionKey,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
} from "../../plugin-sdk/routing.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

function createSessionRouteTestPlugin(params: {
  id: ChannelPlugin["id"];
  label: string;
  resolveOutboundSessionRoute: (
    params: ChannelOutboundSessionRouteParams,
  ) => Awaited<
    ReturnType<NonNullable<NonNullable<ChannelPlugin["messaging"]>["resolveOutboundSessionRoute"]>>
  >;
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      capabilities: { chatTypes: ["direct", "group", "channel"] },
      id: params.id,
      label: params.label,
    }),
    messaging: {
      resolveOutboundSessionRoute: params.resolveOutboundSessionRoute,
    },
  };
}

function buildThreadedChannelRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
  useSuffix?: boolean;
}) {
  const baseSessionKey = buildOutboundBaseSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: params.channel,
    peer: params.peer,
  });
  const normalizedThreadId = normalizeOutboundThreadId(params.threadId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: normalizedThreadId,
    useSuffix: params.useSuffix,
  });
  return {
    baseSessionKey,
    chatType: params.chatType,
    from: params.from,
    peer: params.peer,
    sessionKey: threadKeys.sessionKey,
    to: params.to,
    ...(normalizedThreadId !== undefined ? { threadId: params.threadId } : {}),
  };
}

function parseTelegramTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw
    .trim()
    .replace(/^telegram:/i, "")
    .replace(/^tg:/i, "")
    .replace(/^group:/i, "");
  const prefixedTopic = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (prefixedTopic) {
    const chatId = prefixedTopic[1];
    return {
      chatId,
      chatType: chatId.startsWith("-") ? "group" : "direct",
      messageThreadId: Number.parseInt(prefixedTopic[2], 10),
    };
  }
  return {
    chatId: trimmed,
    chatType: trimmed.startsWith("-") ? "group" : trimmed.startsWith("@") ? "unknown" : "direct",
  };
}

function parseTelegramThreadIdForTest(threadId?: string | number | null): number | undefined {
  const normalized = normalizeOutboundThreadId(threadId);
  if (!normalized) {
    return undefined;
  }
  const topicMatch = /(?:^|:topic:|:)(\d+)$/i.exec(normalized);
  if (!topicMatch) {
    return undefined;
  }
  return Number.parseInt(topicMatch[1], 10);
}

function buildTelegramGroupPeerIdForTest(chatId: string, messageThreadId?: number): string {
  return messageThreadId ? `${chatId}:topic:${messageThreadId}` : chatId;
}

function resolveTelegramOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const parsed = parseTelegramTargetForTest(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const resolvedThreadId = parsed.messageThreadId ?? parseTelegramThreadIdForTest(params.threadId);
  const isGroup =
    parsed.chatType === "group" ||
    (parsed.chatType === "unknown" &&
      params.resolvedTarget?.kind !== undefined &&
      params.resolvedTarget.kind !== "user");
  const peerId =
    isGroup && resolvedThreadId
      ? buildTelegramGroupPeerIdForTest(chatId, resolvedThreadId)
      : chatId;
  const peer: RoutePeer = {
    id: peerId,
    kind: isGroup ? "group" : "direct",
  };
  if (isGroup) {
    return buildChannelOutboundSessionRoute({
      accountId: params.accountId,
      agentId: params.agentId,
      cfg: params.cfg,
      channel: "telegram",
      chatType: "group",
      from: `telegram:group:${peerId}`,
      peer,
      to: `telegram:${chatId}`,
      ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
    });
  }
  return buildThreadedChannelRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "telegram",
    chatType: "direct",
    from:
      resolvedThreadId !== undefined
        ? `telegram:${chatId}:topic:${resolvedThreadId}`
        : `telegram:${chatId}`,
    peer,
    threadId: resolvedThreadId,
    to: `telegram:${chatId}`,
  });
}

function resolveSlackOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "slack"));
  if (!rawId) {
    return null;
  }
  const normalizedId = normalizeLowercaseStringOrEmpty(rawId);
  const isDm = lower.startsWith("user:") || lower.startsWith("slack:") || /^u/i.test(rawId);
  const isGroupChannel =
    /^g/i.test(rawId) &&
    params.cfg.channels?.slack?.dm?.groupChannels?.some(
      (candidate) => normalizeLowercaseStringOrEmpty(String(candidate)) === normalizedId,
    ) === true;
  const peerKind: RoutePeer["kind"] = isDm ? "direct" : isGroupChannel ? "group" : "channel";
  return buildThreadedChannelRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "slack",
    chatType: peerKind === "direct" ? "direct" : peerKind === "group" ? "group" : "channel",
    from: isDm
      ? `slack:${rawId}`
      : isGroupChannel
        ? `slack:group:${rawId}`
        : `slack:channel:${rawId}`,
    peer: { id: normalizedId, kind: peerKind },
    threadId: params.replyToId ?? params.threadId ?? undefined,
    to: isDm ? `user:${rawId}` : `channel:${rawId}`,
  });
}

function resolveDiscordOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const resolvedKind = params.resolvedTarget?.kind;
  let kind: "user" | "channel";
  if (resolvedKind === "user") {
    kind = "user";
  } else if (resolvedKind === "channel" || resolvedKind === "group") {
    kind = "channel";
  } else if (/^user:/i.test(trimmed) || /^discord:/i.test(trimmed) || /^<@!?/.test(trimmed)) {
    kind = "user";
  } else if (/^channel:/i.test(trimmed)) {
    kind = "channel";
  } else if (/^\d+$/u.test(trimmed)) {
    throw new Error("Ambiguous Discord recipient");
  } else {
    kind = "channel";
  }
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "discord"));
  if (!rawId) {
    return null;
  }
  const peer: RoutePeer = {
    id: rawId,
    kind: kind === "user" ? "direct" : "channel",
  };
  return buildThreadedChannelRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "discord",
    chatType: kind === "user" ? "direct" : "channel",
    from: kind === "user" ? `discord:${rawId}` : `discord:channel:${rawId}`,
    peer,
    threadId: params.threadId ?? undefined,
    to: kind === "user" ? `user:${rawId}` : `channel:${rawId}`,
    useSuffix: false,
  });
}

function resolveMattermostOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const isUser = params.resolvedTarget?.kind === "user" || /^user:/i.test(trimmed);
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "mattermost"));
  if (!rawId) {
    return null;
  }
  return buildThreadedChannelRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "mattermost",
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    peer: { id: rawId, kind: isUser ? "direct" : "channel" },
    threadId: params.replyToId ?? params.threadId ?? undefined,
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
  });
}

function resolveWhatsAppOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizeOptionalLowercaseString(
    stripChannelTargetPrefix(params.target, "whatsapp"),
  );
  if (!normalized) {
    return null;
  }
  const isGroup = normalized.endsWith("@g.us");
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "whatsapp",
    chatType: isGroup ? "group" : "direct",
    from: normalized,
    peer: { id: normalized, kind: isGroup ? "group" : "direct" },
    to: normalized,
  });
}

function resolveMatrixOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "matrix");
  const isUser =
    params.resolvedTarget?.kind === "user" || stripped.startsWith("@") || /^user:/i.test(stripped);
  const rawId = stripTargetKindPrefix(stripped);
  if (!rawId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "matrix",
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `matrix:${rawId}` : `matrix:channel:${rawId}`,
    peer: { id: rawId, kind: isUser ? "direct" : "channel" },
    to: `room:${rawId}`,
  });
}

function resolveMSTeamsOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "msteams", "teams");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const conversationId = rawId.split(";")[0] ?? rawId;
  const isUser = lower.startsWith("user:");
  const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
  const peerKind: RoutePeer["kind"] = isUser ? "direct" : isChannel ? "channel" : "group";
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "msteams",
    chatType: peerKind,
    from: isUser
      ? `msteams:${conversationId}`
      : isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`,
    peer: { id: conversationId, kind: peerKind },
    to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`,
  });
}

function resolveFeishuOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "feishu", "lark");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  let isGroup = false;
  if (lower.startsWith("group:") || lower.startsWith("chat:") || lower.startsWith("channel:")) {
    trimmed = trimmed.replace(/^(group|chat|channel):/i, "").trim();
    isGroup = true;
  } else if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    trimmed = trimmed.replace(/^(user|dm):/i, "").trim();
  } else if (
    !normalizeLowercaseStringOrEmpty(trimmed).startsWith("ou_") &&
    !normalizeLowercaseStringOrEmpty(trimmed).startsWith("on_")
  ) {
    isGroup = false;
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "feishu",
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `feishu:group:${trimmed}` : `feishu:${trimmed}`,
    peer: { id: trimmed, kind: isGroup ? "group" : "direct" },
    to: trimmed,
  });
}

function resolveNextcloudTalkOutboundSessionRouteForTest(
  params: ChannelOutboundSessionRouteParams,
) {
  const roomId = stripTargetKindPrefix(
    stripChannelTargetPrefix(params.target, "nextcloud-talk", "nc-talk", "nc"),
  );
  if (!roomId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "nextcloud-talk",
    chatType: "group",
    from: `nextcloud-talk:room:${roomId}`,
    peer: { id: roomId, kind: "group" },
    to: `nextcloud-talk:${roomId}`,
  });
}

function resolveBlueBubblesOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "bluebubbles");
  if (!stripped) {
    return null;
  }
  const match = /^(chat_guid|chat_identifier|chat_id):(.+)$/i.exec(stripped);
  const rawId = match ? match[2].trim() : stripped.trim();
  if (!rawId) {
    return null;
  }
  const normalizedId = normalizeLowercaseStringOrEmpty(rawId);
  const isGroup = match !== null;
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "bluebubbles",
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `group:${rawId}` : `bluebubbles:${rawId}`,
    peer: { id: normalizedId, kind: isGroup ? "group" : "direct" },
    to: `bluebubbles:${stripped}`,
  });
}

function resolveZaloOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "zalo", "zl");
  if (!trimmed) {
    return null;
  }
  const isGroup = normalizeLowercaseStringOrEmpty(trimmed).startsWith("group:");
  const peerId = stripTargetKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "zalo",
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalo:group:${peerId}` : `zalo:${peerId}`,
    peer: { id: peerId, kind: isGroup ? "group" : "direct" },
    to: `zalo:${peerId}`,
  });
}

function resolveZalouserOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "zalouser", "zlu");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const isGroup = lower.startsWith("group:") || lower.startsWith("g:");
  const peerId = trimmed.replace(/^(group|user|g|u|dm):/i, "").trim();
  if (!peerId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "zalouser",
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `zalouser:group:${peerId}` : `zalouser:${peerId}`,
    peer: { id: peerId, kind: isGroup ? "group" : "direct" },
    to: `zalouser:${peerId}`,
  });
}

function resolveNostrOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const target = stripChannelTargetPrefix(params.target, "nostr");
  if (!target) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "nostr",
    chatType: "direct",
    from: `nostr:${target}`,
    peer: { id: target, kind: "direct" },
    to: `nostr:${target}`,
  });
}

function resolveTlonOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "tlon").trim();
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:")) {
    const nest = `chat/${trimmed.slice("group:".length).trim()}`;
    return buildChannelOutboundSessionRoute({
      accountId: params.accountId,
      agentId: params.agentId,
      cfg: params.cfg,
      channel: "tlon",
      chatType: "group",
      from: `tlon:group:${nest}`,
      peer: { id: nest, kind: "group" },
      to: `tlon:${nest}`,
    });
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "tlon",
    chatType: "direct",
    from: `tlon:${trimmed}`,
    peer: { id: trimmed, kind: "direct" },
    to: `tlon:${trimmed}`,
  });
}

export function setMinimalOutboundSessionPluginRegistryForTests(): void {
  const plugins: ChannelPlugin[] = [
    createSessionRouteTestPlugin({
      id: "whatsapp",
      label: "WhatsApp",
      resolveOutboundSessionRoute: resolveWhatsAppOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "matrix",
      label: "Matrix",
      resolveOutboundSessionRoute: resolveMatrixOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "msteams",
      label: "Microsoft Teams",
      resolveOutboundSessionRoute: resolveMSTeamsOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "slack",
      label: "Slack",
      resolveOutboundSessionRoute: resolveSlackOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "telegram",
      label: "Telegram",
      resolveOutboundSessionRoute: resolveTelegramOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "discord",
      label: "Discord",
      resolveOutboundSessionRoute: resolveDiscordOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "nextcloud-talk",
      label: "Nextcloud Talk",
      resolveOutboundSessionRoute: resolveNextcloudTalkOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "bluebubbles",
      label: "BlueBubbles",
      resolveOutboundSessionRoute: resolveBlueBubblesOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "zalo",
      label: "Zalo",
      resolveOutboundSessionRoute: resolveZaloOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "zalouser",
      label: "Zalo Personal",
      resolveOutboundSessionRoute: resolveZalouserOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "nostr",
      label: "Nostr",
      resolveOutboundSessionRoute: resolveNostrOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "tlon",
      label: "Tlon",
      resolveOutboundSessionRoute: resolveTlonOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "feishu",
      label: "Feishu",
      resolveOutboundSessionRoute: resolveFeishuOutboundSessionRouteForTest,
    }),
    createSessionRouteTestPlugin({
      id: "mattermost",
      label: "Mattermost",
      resolveOutboundSessionRoute: resolveMattermostOutboundSessionRouteForTest,
    }),
  ];
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((plugin) => ({
        plugin,
        pluginId: plugin.id,
        source: "test",
      })),
    ),
  );
}
