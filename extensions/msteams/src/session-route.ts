import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
} from "openclaw/plugin-sdk/channel-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function resolveMSTeamsOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "msteams", "teams");
  if (!trimmed) {
    return null;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const isUser = lower.startsWith("user:");
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const conversationId = rawId.split(";")[0] ?? rawId;
  const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "msteams",
    chatType: isUser ? "direct" : (isChannel ? "channel" : "group"),
    from: isUser
      ? `msteams:${conversationId}`
      : (isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`),
    peer: {
      id: conversationId,
      kind: isUser ? "direct" : (isChannel ? "channel" : "group"),
    },
    to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`,
  });
}
