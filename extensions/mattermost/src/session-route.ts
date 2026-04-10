import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
  resolveThreadSessionKeys,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
} from "openclaw/plugin-sdk/core";
import { normalizeOutboundThreadId } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function resolveMattermostOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "mattermost");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const resolvedKind = params.resolvedTarget?.kind;
  const isUser =
    resolvedKind === "user" ||
    (resolvedKind !== "channel" &&
      resolvedKind !== "group" &&
      (lower.startsWith("user:") || trimmed.startsWith("@")));
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  }
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const baseRoute = buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "mattermost",
    chatType: isUser ? "direct" : "channel",
    from: isUser ? `mattermost:${rawId}` : `mattermost:channel:${rawId}`,
    peer: {
      id: rawId,
      kind: isUser ? "direct" : "channel",
    },
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
  });
  const threadId = normalizeOutboundThreadId(params.replyToId ?? params.threadId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: baseRoute.baseSessionKey,
    threadId,
  });
  return {
    ...baseRoute,
    sessionKey: threadKeys.sessionKey,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}
