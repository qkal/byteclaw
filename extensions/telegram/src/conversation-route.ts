import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type ConfiguredBindingRouteResult,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { isPluginOwnedSessionBindingRecord } from "openclaw/plugin-sdk/conversation-runtime";
import {
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import {
  DEFAULT_ACCOUNT_ID,
  buildAgentMainSessionKey,
  resolveAgentIdFromSessionKey,
  sanitizeAgentId,
} from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramDirectPeerId,
} from "./bot/helpers.js";

export function resolveTelegramConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: number | string;
  isGroup: boolean;
  resolvedThreadId?: number;
  replyThreadId?: number;
  senderId?: string | number | null;
  topicAgentId?: string | null;
}): {
  route: ReturnType<typeof resolveAgentRoute>;
  configuredBinding: ConfiguredBindingRouteResult["bindingResolution"];
  configuredBindingSessionKey: string;
} {
  const peerId = params.isGroup
    ? buildTelegramGroupPeerId(params.chatId, params.resolvedThreadId)
    : resolveTelegramDirectPeerId({
        chatId: params.chatId,
        senderId: params.senderId,
      });
  const parentPeer = buildTelegramParentPeer({
    chatId: params.chatId,
    isGroup: params.isGroup,
    resolvedThreadId: params.resolvedThreadId,
  });
  let route = resolveAgentRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "telegram",
    parentPeer,
    peer: {
      id: peerId,
      kind: params.isGroup ? "group" : "direct",
    },
  });

  const rawTopicAgentId = params.topicAgentId?.trim();
  if (rawTopicAgentId) {
    // Preserve the configured topic agent ID so topic-bound sessions stay stable
    // Even when that agent is not present in the current config snapshot.
    const topicAgentId = sanitizeAgentId(rawTopicAgentId);
    const sessionKey = normalizeLowercaseStringOrEmpty(
      buildAgentSessionKey({
        accountId: params.accountId,
        agentId: topicAgentId,
        channel: "telegram",
        dmScope: params.cfg.session?.dmScope,
        identityLinks: params.cfg.session?.identityLinks,
        peer: { id: peerId, kind: params.isGroup ? "group" : "direct" },
      }),
    );
    const mainSessionKey = normalizeLowercaseStringOrEmpty(
      buildAgentMainSessionKey({
        agentId: topicAgentId,
      }),
    );
    route = {
      ...route,
      agentId: topicAgentId,
      lastRoutePolicy: deriveLastRoutePolicy({
        mainSessionKey,
        sessionKey,
      }),
      mainSessionKey,
      sessionKey,
    };
    logVerbose(
      `telegram: topic route override: topic=${params.resolvedThreadId ?? params.replyThreadId} agent=${topicAgentId} sessionKey=${route.sessionKey}`,
    );
  }

  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    conversation: {
      accountId: params.accountId,
      channel: "telegram",
      conversationId: peerId,
      parentConversationId: params.isGroup ? String(params.chatId) : undefined,
    },
    route,
  });
  let configuredBinding = configuredRoute.bindingResolution;
  let configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
  ({ route } = configuredRoute);

  const threadBindingConversationId =
    params.replyThreadId != null
      ? `${params.chatId}:topic:${params.replyThreadId}`
      : !params.isGroup
        ? String(params.chatId)
        : undefined;
  if (threadBindingConversationId) {
    const threadBinding = getSessionBindingService().resolveByConversation({
      accountId: params.accountId,
      channel: "telegram",
      conversationId: threadBindingConversationId,
    });
    const boundSessionKey = threadBinding?.targetSessionKey?.trim();
    if (threadBinding && boundSessionKey) {
      if (!isPluginOwnedSessionBindingRecord(threadBinding)) {
        route = {
          ...route,
          agentId: resolveAgentIdFromSessionKey(boundSessionKey),
          lastRoutePolicy: deriveLastRoutePolicy({
            mainSessionKey: route.mainSessionKey,
            sessionKey: boundSessionKey,
          }),
          matchedBy: "binding.channel",
          sessionKey: boundSessionKey,
        };
      }
      configuredBinding = null;
      configuredBindingSessionKey = "";
      getSessionBindingService().touch(threadBinding.bindingId);
      logVerbose(
        isPluginOwnedSessionBindingRecord(threadBinding)
          ? `telegram: plugin-bound conversation ${threadBindingConversationId}`
          : `telegram: routed via bound conversation ${threadBindingConversationId} -> ${boundSessionKey}`,
      );
    }
  }

  return {
    configuredBinding,
    configuredBindingSessionKey,
    route,
  };
}

export function resolveTelegramConversationBaseSessionKey(params: {
  cfg: OpenClawConfig;
  route: Pick<
    ReturnType<typeof resolveTelegramConversationRoute>["route"],
    "agentId" | "accountId" | "matchedBy" | "sessionKey"
  >;
  chatId: number | string;
  isGroup: boolean;
  senderId?: string | number | null;
}): string {
  const isNamedAccountFallback =
    params.route.accountId !== DEFAULT_ACCOUNT_ID && params.route.matchedBy === "default";
  if (!isNamedAccountFallback || params.isGroup) {
    return params.route.sessionKey;
  }
  return normalizeLowercaseStringOrEmpty(
    buildAgentSessionKey({
      accountId: params.route.accountId,
      agentId: params.route.agentId,
      channel: "telegram",
      dmScope: "per-account-channel-peer",
      identityLinks: params.cfg.session?.identityLinks,
      peer: {
        id: resolveTelegramDirectPeerId({
          chatId: params.chatId,
          senderId: params.senderId,
        }),
        kind: "direct",
      },
    }),
  );
}
