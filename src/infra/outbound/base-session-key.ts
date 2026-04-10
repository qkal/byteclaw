import type { OpenClawConfig } from "../../config/config.js";
import { type RoutePeer, buildAgentSessionKey } from "../../routing/resolve-route.js";

export function buildOutboundBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: RoutePeer;
}): string {
  return buildAgentSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    channel: params.channel,
    dmScope: params.cfg.session?.dmScope ?? "main",
    identityLinks: params.cfg.session?.identityLinks,
    peer: params.peer,
  });
}
