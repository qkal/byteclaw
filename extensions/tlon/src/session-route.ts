import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
} from "openclaw/plugin-sdk/core";
import { parseTlonTarget } from "./targets.js";

export function resolveTlonOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const parsed = parseTlonTarget(params.target);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === "group") {
    return buildChannelOutboundSessionRoute({
      accountId: params.accountId,
      agentId: params.agentId,
      cfg: params.cfg,
      channel: "tlon",
      chatType: "group",
      from: `tlon:group:${parsed.nest}`,
      peer: {
        id: parsed.nest,
        kind: "group",
      },
      to: `tlon:${parsed.nest}`,
    });
  }
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "tlon",
    chatType: "direct",
    from: `tlon:${parsed.ship}`,
    peer: {
      id: parsed.ship,
      kind: "direct",
    },
    to: `tlon:${parsed.ship}`,
  });
}
