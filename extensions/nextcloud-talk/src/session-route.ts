import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
} from "openclaw/plugin-sdk/channel-core";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";

export function resolveNextcloudTalkOutboundSessionRoute(
  params: ChannelOutboundSessionRouteParams,
) {
  const roomId = stripNextcloudTalkTargetPrefix(params.target);
  if (!roomId) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "nextcloud-talk",
    chatType: "group",
    from: `nextcloud-talk:room:${roomId}`,
    peer: {
      id: roomId,
      kind: "group",
    },
    to: `nextcloud-talk:${roomId}`,
  });
}
