import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  getSessionBindingService,
  isPluginOwnedSessionBindingRecord,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  deriveLastRoutePolicy,
  resolveAgentIdFromSessionKey,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveIMessageInboundConversationId } from "./conversation-id.js";

export function resolveIMessageConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  peerId: string;
  sender: string;
  chatId?: number;
}): ReturnType<typeof resolveAgentRoute> {
  let route = resolveAgentRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "imessage",
    peer: {
      id: params.peerId,
      kind: params.isGroup ? "group" : "direct",
    },
  });

  const conversationId = resolveIMessageInboundConversationId({
    chatId: params.chatId,
    isGroup: params.isGroup,
    sender: params.sender,
  });
  if (!conversationId) {
    return route;
  }

  ({ route } = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    conversation: {
      accountId: params.accountId,
      channel: "imessage",
      conversationId,
    },
    route,
  }));

  const runtimeBinding = getSessionBindingService().resolveByConversation({
    accountId: params.accountId,
    channel: "imessage",
    conversationId,
  });
  const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();
  if (!runtimeBinding || !boundSessionKey) {
    return route;
  }

  getSessionBindingService().touch(runtimeBinding.bindingId);
  if (isPluginOwnedSessionBindingRecord(runtimeBinding)) {
    logVerbose(`imessage: plugin-bound conversation ${conversationId}`);
    return route;
  }

  logVerbose(`imessage: routed via bound conversation ${conversationId} -> ${boundSessionKey}`);
  return {
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
