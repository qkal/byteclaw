import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
} from "openclaw/plugin-sdk/channel-core";
import { parseBlueBubblesTarget } from "./targets.js";

export function resolveBlueBubblesOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "bluebubbles");
  if (!stripped) {
    return null;
  }
  const parsed = parseBlueBubblesTarget(stripped);
  const isGroup =
    parsed.kind === "chat_id" || parsed.kind === "chat_guid" || parsed.kind === "chat_identifier";
  const peerId =
    parsed.kind === "chat_id"
      ? String(parsed.chatId)
      : parsed.kind === "chat_guid"
        ? parsed.chatGuid
        : parsed.kind === "chat_identifier"
          ? parsed.chatIdentifier
          : parsed.to;
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "bluebubbles",
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `group:${peerId}` : `bluebubbles:${peerId}`,
    peer: {
      id: peerId,
      kind: isGroup ? "group" : "direct",
    },
    to: `bluebubbles:${stripped}`,
  });
}
