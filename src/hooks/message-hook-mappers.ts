import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageSentEvent,
} from "../plugins/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type {
  MessagePreprocessedHookContext,
  MessageReceivedHookContext,
  MessageSentHookContext,
  MessageTranscribedHookContext,
} from "./internal-hooks.js";

export interface CanonicalInboundMessageHookContext {
  from: string;
  to?: string;
  content: string;
  body?: string;
  bodyForAgent?: string;
  transcript?: string;
  timestamp?: number;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  provider?: string;
  surface?: string;
  threadId?: string | number;
  mediaPath?: string;
  mediaType?: string;
  mediaPaths?: string[];
  mediaTypes?: string[];
  originatingChannel?: string;
  originatingTo?: string;
  guildId?: string;
  channelName?: string;
  isGroup: boolean;
  groupId?: string;
}

export interface CanonicalSentMessageHookContext {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
}

export function deriveInboundMessageHookContext(
  ctx: FinalizedMsgContext,
  overrides?: {
    content?: string;
    messageId?: string;
  },
): CanonicalInboundMessageHookContext {
  const content =
    overrides?.content ??
    (typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.RawBody === "string"
        ? ctx.RawBody
        : typeof ctx.Body === "string"
          ? ctx.Body
          : "");
  const channelId = normalizeLowercaseStringOrEmpty(
    ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "",
  );
  const conversationId = ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? undefined;
  const isGroup = Boolean(ctx.GroupSubject || ctx.GroupChannel);
  const mediaPaths = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  const mediaTypes = Array.isArray(ctx.MediaTypes)
    ? ctx.MediaTypes.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : undefined;
  return {
    accountId: ctx.AccountId,
    body: ctx.Body,
    bodyForAgent: ctx.BodyForAgent,
    channelId,
    channelName: ctx.GroupChannel,
    content,
    conversationId,
    from: ctx.From ?? "",
    groupId: isGroup ? conversationId : undefined,
    guildId: ctx.GroupSpace,
    isGroup,
    mediaPath: ctx.MediaPath ?? mediaPaths?.[0],
    mediaPaths,
    mediaType: ctx.MediaType ?? mediaTypes?.[0],
    mediaTypes,
    messageId:
      overrides?.messageId ??
      ctx.MessageSidFull ??
      ctx.MessageSid ??
      ctx.MessageSidFirst ??
      ctx.MessageSidLast,
    originatingChannel: ctx.OriginatingChannel,
    originatingTo: ctx.OriginatingTo,
    provider: ctx.Provider,
    senderE164: ctx.SenderE164,
    senderId: ctx.SenderId,
    senderName: ctx.SenderName,
    senderUsername: ctx.SenderUsername,
    surface: ctx.Surface,
    threadId: ctx.MessageThreadId,
    timestamp:
      typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp)
        ? ctx.Timestamp
        : undefined,
    to: ctx.To,
    transcript: ctx.Transcript,
  };
}

export function buildCanonicalSentMessageHookContext(params: {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
}): CanonicalSentMessageHookContext {
  return {
    accountId: params.accountId,
    channelId: params.channelId,
    content: params.content,
    conversationId: params.conversationId ?? params.to,
    error: params.error,
    groupId: params.groupId,
    isGroup: params.isGroup,
    messageId: params.messageId,
    success: params.success,
    to: params.to,
  };
}

export function toPluginMessageContext(
  canonical: CanonicalInboundMessageHookContext | CanonicalSentMessageHookContext,
): PluginHookMessageContext {
  return {
    accountId: canonical.accountId,
    channelId: canonical.channelId,
    conversationId: canonical.conversationId,
  };
}

function stripChannelPrefix(value: string | undefined, channelId: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const genericPrefixes = ["channel:", "chat:", "user:"];
  for (const prefix of genericPrefixes) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  const prefix = `${channelId}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function resolveInboundConversation(canonical: CanonicalInboundMessageHookContext): {
  conversationId?: string;
  parentConversationId?: string;
} {
  const channelId = normalizeChannelId(canonical.channelId);
  const pluginResolved = channelId
    ? getChannelPlugin(channelId)?.messaging?.resolveInboundConversation?.({
        conversationId: canonical.conversationId,
        from: canonical.from,
        isGroup: canonical.isGroup,
        threadId: canonical.threadId,
        to: canonical.to ?? canonical.originatingTo,
      })
    : null;
  if (pluginResolved) {
    return {
      conversationId: normalizeOptionalString(pluginResolved.conversationId),
      parentConversationId: normalizeOptionalString(pluginResolved.parentConversationId),
    };
  }
  const baseConversationId = stripChannelPrefix(
    canonical.to ?? canonical.originatingTo ?? canonical.conversationId,
    canonical.channelId,
  );
  return { conversationId: baseConversationId };
}

export function toPluginInboundClaimContext(
  canonical: CanonicalInboundMessageHookContext,
): PluginHookInboundClaimContext {
  const conversation = resolveInboundConversation(canonical);
  return {
    accountId: canonical.accountId,
    channelId: canonical.channelId,
    conversationId: conversation.conversationId,
    messageId: canonical.messageId,
    parentConversationId: conversation.parentConversationId,
    senderId: canonical.senderId,
  };
}

export function toPluginInboundClaimEvent(
  canonical: CanonicalInboundMessageHookContext,
  extras?: {
    commandAuthorized?: boolean;
    wasMentioned?: boolean;
  },
): PluginHookInboundClaimEvent {
  const context = toPluginInboundClaimContext(canonical);
  return {
    accountId: canonical.accountId,
    body: canonical.body,
    bodyForAgent: canonical.bodyForAgent,
    channel: canonical.channelId,
    commandAuthorized: extras?.commandAuthorized,
    content: canonical.content,
    conversationId: context.conversationId,
    isGroup: canonical.isGroup,
    messageId: canonical.messageId,
    metadata: {
      channelName: canonical.channelName,
      from: canonical.from,
      groupId: canonical.groupId,
      guildId: canonical.guildId,
      mediaPath: canonical.mediaPath,
      mediaPaths: canonical.mediaPaths,
      mediaType: canonical.mediaType,
      mediaTypes: canonical.mediaTypes,
      originatingChannel: canonical.originatingChannel,
      originatingTo: canonical.originatingTo,
      provider: canonical.provider,
      senderE164: canonical.senderE164,
      surface: canonical.surface,
      to: canonical.to,
    },
    parentConversationId: context.parentConversationId,
    senderId: canonical.senderId,
    senderName: canonical.senderName,
    senderUsername: canonical.senderUsername,
    threadId: canonical.threadId,
    timestamp: canonical.timestamp,
    transcript: canonical.transcript,
    wasMentioned: extras?.wasMentioned,
  };
}

export function toPluginMessageReceivedEvent(
  canonical: CanonicalInboundMessageHookContext,
): PluginHookMessageReceivedEvent {
  return {
    content: canonical.content,
    from: canonical.from,
    metadata: {
      channelName: canonical.channelName,
      guildId: canonical.guildId,
      messageId: canonical.messageId,
      originatingChannel: canonical.originatingChannel,
      originatingTo: canonical.originatingTo,
      provider: canonical.provider,
      senderE164: canonical.senderE164,
      senderId: canonical.senderId,
      senderName: canonical.senderName,
      senderUsername: canonical.senderUsername,
      surface: canonical.surface,
      threadId: canonical.threadId,
      to: canonical.to,
    },
    timestamp: canonical.timestamp,
  };
}

export function toPluginMessageSentEvent(
  canonical: CanonicalSentMessageHookContext,
): PluginHookMessageSentEvent {
  return {
    content: canonical.content,
    success: canonical.success,
    to: canonical.to,
    ...(canonical.error ? { error: canonical.error } : {}),
  };
}

export function toInternalMessageReceivedContext(
  canonical: CanonicalInboundMessageHookContext,
): MessageReceivedHookContext {
  return {
    accountId: canonical.accountId,
    channelId: canonical.channelId,
    content: canonical.content,
    conversationId: canonical.conversationId,
    from: canonical.from,
    messageId: canonical.messageId,
    metadata: {
      channelName: canonical.channelName,
      guildId: canonical.guildId,
      provider: canonical.provider,
      senderE164: canonical.senderE164,
      senderId: canonical.senderId,
      senderName: canonical.senderName,
      senderUsername: canonical.senderUsername,
      surface: canonical.surface,
      threadId: canonical.threadId,
      to: canonical.to,
    },
    timestamp: canonical.timestamp,
  };
}

export function toInternalMessageTranscribedContext(
  canonical: CanonicalInboundMessageHookContext,
  cfg: OpenClawConfig,
): MessageTranscribedHookContext & { cfg: OpenClawConfig } {
  const shared = toInternalInboundMessageHookContextBase(canonical);
  return {
    ...shared,
    cfg,
    transcript: canonical.transcript ?? "",
  };
}

export function toInternalMessagePreprocessedContext(
  canonical: CanonicalInboundMessageHookContext,
  cfg: OpenClawConfig,
): MessagePreprocessedHookContext & { cfg: OpenClawConfig } {
  const shared = toInternalInboundMessageHookContextBase(canonical);
  return {
    ...shared,
    cfg,
    groupId: canonical.groupId,
    isGroup: canonical.isGroup,
    transcript: canonical.transcript,
  };
}

function toInternalInboundMessageHookContextBase(canonical: CanonicalInboundMessageHookContext) {
  return {
    body: canonical.body,
    bodyForAgent: canonical.bodyForAgent,
    channelId: canonical.channelId,
    conversationId: canonical.conversationId,
    from: canonical.from,
    mediaPath: canonical.mediaPath,
    mediaType: canonical.mediaType,
    messageId: canonical.messageId,
    provider: canonical.provider,
    senderId: canonical.senderId,
    senderName: canonical.senderName,
    senderUsername: canonical.senderUsername,
    surface: canonical.surface,
    timestamp: canonical.timestamp,
    to: canonical.to,
  };
}

export function toInternalMessageSentContext(
  canonical: CanonicalSentMessageHookContext,
): MessageSentHookContext {
  return {
    to: canonical.to,
    content: canonical.content,
    success: canonical.success,
    ...(canonical.error ? { error: canonical.error } : {}),
    channelId: canonical.channelId,
    accountId: canonical.accountId,
    conversationId: canonical.conversationId,
    messageId: canonical.messageId,
    ...(canonical.isGroup != null ? { isGroup: canonical.isGroup } : {}),
    ...(canonical.groupId ? { groupId: canonical.groupId } : {}),
  };
}
