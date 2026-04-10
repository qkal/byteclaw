import type { OpenClawConfig } from "../config/config.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { parseExplicitTargetForChannel } from "./plugins/target-parsing.js";
import type { ChannelPlugin } from "./plugins/types.js";
import { normalizeAnyChannelId, normalizeChannelId } from "./registry.js";

export interface ConversationBindingContext {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string;
}

export interface ResolveConversationBindingContextInput {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  chatType?: string | null;
  threadId?: string | number | null;
  threadParentId?: string | null;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  originatingTo?: string | null;
  commandTo?: string | null;
  fallbackTo?: string | null;
  from?: string | null;
  nativeChannelId?: string | null;
}

const CANONICAL_TARGET_PREFIXES = [
  "user:",
  "channel:",
  "conversation:",
  "group:",
  "room:",
  "dm:",
  "spaces/",
] as const;

function getLoadedChannelPlugin(rawChannel: string): ChannelPlugin | undefined {
  const normalized = normalizeAnyChannelId(rawChannel) ?? normalizeOptionalString(rawChannel);
  if (!normalized) {
    return undefined;
  }
  return getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === normalized)
    ?.plugin;
}

function shouldDefaultParentConversationToSelf(plugin?: ChannelPlugin): boolean {
  return plugin?.bindings?.selfParentConversationByDefault === true;
}

function resolveBindingAccountId(params: {
  rawAccountId?: string | null;
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
}): string {
  return (
    normalizeOptionalString(params.rawAccountId) ||
    normalizeOptionalString(params.plugin?.config.defaultAccountId?.(params.cfg)) ||
    "default"
  );
}

function resolveChannelTargetId(params: {
  channel: string;
  target?: string | null;
}): string | undefined {
  const target = normalizeOptionalString(params.target);
  if (!target) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(target);
  const channelPrefix = `${params.channel}:`;
  if (lower.startsWith(channelPrefix)) {
    return resolveChannelTargetId({
      channel: params.channel,
      target: target.slice(channelPrefix.length),
    });
  }
  if (CANONICAL_TARGET_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return target;
  }

  const parsed = parseExplicitTargetForChannel(params.channel, target);
  const parsedTarget = normalizeOptionalString(parsed?.to);
  if (parsedTarget) {
    return (
      resolveConversationIdFromTargets({
        targets: [parsedTarget],
      }) ?? parsedTarget
    );
  }

  const explicitConversationId = resolveConversationIdFromTargets({
    targets: [target],
  });
  return explicitConversationId ?? target;
}

function buildThreadingContext(params: {
  fallbackTo?: string;
  originatingTo?: string;
  threadId?: string;
  from?: string;
  chatType?: string;
  nativeChannelId?: string;
}) {
  const to =
    normalizeOptionalString(params.originatingTo) ?? normalizeOptionalString(params.fallbackTo);
  return {
    ...(to ? { To: to } : {}),
    ...(params.from ? { From: params.from } : {}),
    ...(params.chatType ? { ChatType: params.chatType } : {}),
    ...(params.threadId ? { MessageThreadId: params.threadId } : {}),
    ...(params.nativeChannelId ? { NativeChannelId: params.nativeChannelId } : {}),
  };
}

export function resolveConversationBindingContext(
  params: ResolveConversationBindingContextInput,
): ConversationBindingContext | null {
  const channel =
    normalizeAnyChannelId(params.channel) ??
    normalizeChannelId(params.channel) ??
    normalizeOptionalLowercaseString(params.channel);
  if (!channel) {
    return null;
  }
  const loadedPlugin = getLoadedChannelPlugin(channel);
  const accountId = resolveBindingAccountId({
    cfg: params.cfg,
    plugin: loadedPlugin,
    rawAccountId: params.accountId,
  });
  const threadId = normalizeOptionalString(
    params.threadId != null ? String(params.threadId) : undefined,
  );

  const resolvedByProvider = loadedPlugin?.bindings?.resolveCommandConversation?.({
    accountId,
    chatType: normalizeOptionalString(params.chatType),
    commandTo: params.commandTo ?? undefined,
    fallbackTo: params.fallbackTo ?? undefined,
    from: normalizeOptionalString(params.from),
    originatingTo: params.originatingTo ?? undefined,
    parentSessionKey: normalizeOptionalString(params.parentSessionKey),
    senderId: normalizeOptionalString(params.senderId),
    sessionKey: normalizeOptionalString(params.sessionKey),
    threadId,
    threadParentId: normalizeOptionalString(params.threadParentId),
  });
  if (resolvedByProvider?.conversationId) {
    const resolvedParentConversationId =
      shouldDefaultParentConversationToSelf(loadedPlugin) &&
      !threadId &&
      !resolvedByProvider.parentConversationId
        ? resolvedByProvider.conversationId
        : resolvedByProvider.parentConversationId;
    return {
      accountId,
      channel,
      conversationId: resolvedByProvider.conversationId,
      ...(resolvedParentConversationId
        ? { parentConversationId: resolvedParentConversationId }
        : {}),
      ...(threadId ? { threadId } : {}),
    };
  }

  const focusedBinding = loadedPlugin?.threading?.resolveFocusedBinding?.({
    accountId,
    cfg: params.cfg,
    context: buildThreadingContext({
      chatType: normalizeOptionalString(params.chatType),
      fallbackTo: params.fallbackTo ?? undefined,
      from: normalizeOptionalString(params.from),
      nativeChannelId: normalizeOptionalString(params.nativeChannelId),
      originatingTo: params.originatingTo ?? undefined,
      threadId,
    }),
  });
  if (focusedBinding?.conversationId) {
    return {
      accountId,
      channel,
      conversationId: focusedBinding.conversationId,
      ...(focusedBinding.parentConversationId
        ? { parentConversationId: focusedBinding.parentConversationId }
        : {}),
      ...(threadId ? { threadId } : {}),
    };
  }

  const baseConversationId =
    resolveChannelTargetId({
      channel,
      target: params.originatingTo,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.commandTo,
    }) ??
    resolveChannelTargetId({
      channel,
      target: params.fallbackTo,
    });
  const parentConversationId =
    resolveChannelTargetId({
      channel,
      target: params.threadParentId,
    }) ??
    (threadId && baseConversationId && baseConversationId !== threadId
      ? baseConversationId
      : undefined);
  const conversationId = threadId || baseConversationId;
  if (!conversationId) {
    return null;
  }
  const normalizedParentConversationId =
    shouldDefaultParentConversationToSelf(loadedPlugin) && !threadId && !parentConversationId
      ? conversationId
      : parentConversationId;
  return {
    accountId,
    channel,
    conversationId,
    ...(normalizedParentConversationId
      ? { parentConversationId: normalizedParentConversationId }
      : {}),
    ...(threadId ? { threadId } : {}),
  };
}
