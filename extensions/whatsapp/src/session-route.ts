import {
  type ChannelOutboundSessionRouteParams,
  buildChannelOutboundSessionRoute,
} from "openclaw/plugin-sdk/core";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

export function resolveWhatsAppOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) {
    return null;
  }
  const isGroup = isWhatsAppGroupJid(normalized);
  return buildChannelOutboundSessionRoute({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "whatsapp",
    chatType: isGroup ? "group" : "direct",
    from: normalized,
    peer: {
      id: normalized,
      kind: isGroup ? "group" : "direct",
    },
    to: normalized,
  });
}
