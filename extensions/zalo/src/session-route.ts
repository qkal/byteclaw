import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
} from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function resolveZaloOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
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
    peer: {
      id: peerId,
      kind: isGroup ? "group" : "direct",
    },
    to: `zalo:${peerId}`,
  });
}
