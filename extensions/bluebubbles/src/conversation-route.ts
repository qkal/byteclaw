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
import { resolveBlueBubblesInboundConversationId } from "./conversation-id.js";

export function resolveBlueBubblesConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  peerId: string;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): ReturnType<typeof resolveAgentRoute> {
  let route = resolveAgentRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "bluebubbles",
    peer: {
      id: params.peerId,
      kind: params.isGroup ? "group" : "direct",
    },
  });

  const conversationId = resolveBlueBubblesInboundConversationId({
    chatGuid: params.chatGuid,
    chatId: params.chatId,
    chatIdentifier: params.chatIdentifier,
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
      channel: "bluebubbles",
      conversationId,
    },
    route,
  }));

  const runtimeBinding = getSessionBindingService().resolveByConversation({
    accountId: params.accountId,
    channel: "bluebubbles",
    conversationId,
  });
  const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();
  if (!runtimeBinding || !boundSessionKey) {
    return route;
  }

  getSessionBindingService().touch(runtimeBinding.bindingId);
  if (isPluginOwnedSessionBindingRecord(runtimeBinding)) {
    logVerbose(`bluebubbles: plugin-bound conversation ${conversationId}`);
    return route;
  }

  logVerbose(`bluebubbles: routed via bound conversation ${conversationId} -> ${boundSessionKey}`);
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
