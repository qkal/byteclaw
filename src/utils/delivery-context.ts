import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeAccountId } from "./account-id.js";
import { normalizeMessageChannel } from "./message-channel.js";

export interface DeliveryContext {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}

export interface DeliveryContextSessionSource {
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  deliveryContext?: DeliveryContext;
}

export function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context) {
    return undefined;
  }
  const channel =
    typeof context.channel === "string"
      ? (normalizeMessageChannel(context.channel) ?? context.channel.trim())
      : undefined;
  const to = normalizeOptionalString(context.to);
  const accountId = normalizeAccountId(context.accountId);
  const threadId =
    typeof context.threadId === "number" && Number.isFinite(context.threadId)
      ? Math.trunc(context.threadId)
      : (typeof context.threadId === "string"
        ? normalizeOptionalString(context.threadId)
        : undefined);
  const normalizedThreadId =
    typeof threadId === "string" ? (threadId ? threadId : undefined) : threadId;
  if (!channel && !to && !accountId && normalizedThreadId == null) {
    return undefined;
  }
  const normalized: DeliveryContext = {
    accountId,
    channel: channel || undefined,
    to: to || undefined,
  };
  if (normalizedThreadId != null) {
    normalized.threadId = normalizedThreadId;
  }
  return normalized;
}

export function formatConversationTarget(params: {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
}): string | undefined {
  const channel =
    typeof params.channel === "string"
      ? (normalizeMessageChannel(params.channel) ?? params.channel.trim())
      : undefined;
  const conversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? String(Math.trunc(params.conversationId))
      : (typeof params.conversationId === "string"
        ? normalizeOptionalString(params.conversationId)
        : undefined);
  if (!channel || !conversationId) {
    return undefined;
  }
  const parentConversationId =
    typeof params.parentConversationId === "number" && Number.isFinite(params.parentConversationId)
      ? String(Math.trunc(params.parentConversationId))
      : (typeof params.parentConversationId === "string"
        ? normalizeOptionalString(params.parentConversationId)
        : undefined);
  const pluginTarget = normalizeChannelId(channel)
    ? getChannelPlugin(normalizeChannelId(channel)!)?.messaging?.resolveDeliveryTarget?.({
        conversationId,
        parentConversationId,
      })
    : null;
  if (pluginTarget?.to?.trim()) {
    return pluginTarget.to.trim();
  }
  return `channel:${conversationId}`;
}

export function resolveConversationDeliveryTarget(params: {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
}): { to?: string; threadId?: string } {
  const channel =
    typeof params.channel === "string"
      ? (normalizeMessageChannel(params.channel) ?? params.channel.trim())
      : undefined;
  const conversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? String(Math.trunc(params.conversationId))
      : (typeof params.conversationId === "string"
        ? normalizeOptionalString(params.conversationId)
        : undefined);
  const parentConversationId =
    typeof params.parentConversationId === "number" && Number.isFinite(params.parentConversationId)
      ? String(Math.trunc(params.parentConversationId))
      : (typeof params.parentConversationId === "string"
        ? normalizeOptionalString(params.parentConversationId)
        : undefined);
  const isThreadChild =
    conversationId && parentConversationId && parentConversationId !== conversationId;
  if (channel && isThreadChild) {
    if (
      channel === "matrix" ||
      channel === "slack" ||
      channel === "mattermost" ||
      channel === "telegram"
    ) {
      return {
        threadId: conversationId,
        to: `channel:${parentConversationId}`,
      };
    }
  }
  const pluginTarget =
    channel && conversationId
      ? getChannelPlugin(
          normalizeChannelId(channel) ?? channel,
        )?.messaging?.resolveDeliveryTarget?.({
          conversationId,
          parentConversationId,
        })
      : null;
  if (pluginTarget) {
    return {
      ...(pluginTarget.to?.trim() ? { to: pluginTarget.to.trim() } : {}),
      ...(pluginTarget.threadId?.trim() ? { threadId: pluginTarget.threadId.trim() } : {}),
    };
  }
  const to = formatConversationTarget(params);
  return { to };
}

export function normalizeSessionDeliveryFields(source?: DeliveryContextSessionSource): {
  deliveryContext?: DeliveryContext;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
} {
  if (!source) {
    return {
      deliveryContext: undefined,
      lastAccountId: undefined,
      lastChannel: undefined,
      lastThreadId: undefined,
      lastTo: undefined,
    };
  }

  const merged = mergeDeliveryContext(
    normalizeDeliveryContext({
      accountId: source.lastAccountId,
      channel: source.lastChannel ?? source.channel,
      threadId: source.lastThreadId,
      to: source.lastTo,
    }),
    normalizeDeliveryContext(source.deliveryContext),
  );

  if (!merged) {
    return {
      deliveryContext: undefined,
      lastAccountId: undefined,
      lastChannel: undefined,
      lastThreadId: undefined,
      lastTo: undefined,
    };
  }

  return {
    deliveryContext: merged,
    lastAccountId: merged.accountId,
    lastChannel: merged.channel,
    lastThreadId: merged.threadId,
    lastTo: merged.to,
  };
}

export function deliveryContextFromSession(
  entry?: DeliveryContextSessionSource,
): DeliveryContext | undefined {
  if (!entry) {
    return undefined;
  }
  const source: DeliveryContextSessionSource = {
    channel: entry.channel ?? entry.origin?.provider,
    deliveryContext: entry.deliveryContext,
    lastAccountId: entry.lastAccountId ?? entry.origin?.accountId,
    lastChannel: entry.lastChannel,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    lastTo: entry.lastTo,
    origin: entry.origin,
  };
  return normalizeSessionDeliveryFields(source).deliveryContext;
}

export function mergeDeliveryContext(
  primary?: DeliveryContext,
  fallback?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedPrimary = normalizeDeliveryContext(primary);
  const normalizedFallback = normalizeDeliveryContext(fallback);
  if (!normalizedPrimary && !normalizedFallback) {
    return undefined;
  }
  const channelsConflict =
    normalizedPrimary?.channel &&
    normalizedFallback?.channel &&
    normalizedPrimary.channel !== normalizedFallback.channel;
  return normalizeDeliveryContext({
    channel: normalizedPrimary?.channel ?? normalizedFallback?.channel,
    // Keep route fields paired to their channel; avoid crossing fields between
    // Unrelated channels during session context merges.
    to: channelsConflict
      ? normalizedPrimary?.to
      : (normalizedPrimary?.to ?? normalizedFallback?.to),
    accountId: channelsConflict
      ? normalizedPrimary?.accountId
      : (normalizedPrimary?.accountId ?? normalizedFallback?.accountId),
    threadId: channelsConflict
      ? normalizedPrimary?.threadId
      : (normalizedPrimary?.threadId ?? normalizedFallback?.threadId),
  });
}

export function deliveryContextKey(context?: DeliveryContext): string | undefined {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel || !normalized?.to) {
    return undefined;
  }
  const threadId =
    normalized.threadId != null && normalized.threadId !== "" ? String(normalized.threadId) : "";
  return `${normalized.channel}|${normalized.to}|${normalized.accountId ?? ""}|${threadId}`;
}
