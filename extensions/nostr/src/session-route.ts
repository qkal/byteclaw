import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
} from "openclaw/plugin-sdk/core";

export function resolveNostrOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
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
    peer: {
      id: target,
      kind: "direct",
    },
    to: `nostr:${target}`,
  });
}
