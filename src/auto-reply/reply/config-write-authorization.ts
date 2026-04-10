import {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
} from "../../channels/plugins/config-writes.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";

export function resolveConfigWriteDeniedText(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  channelId: ChannelId | null;
  accountId?: string;
  gatewayClientScopes?: string[];
  target: Parameters<typeof authorizeConfigWrite>[0]["target"];
}): string | null {
  const writeAuth = authorizeConfigWrite({
    allowBypass: canBypassConfigWritePolicy({
      channel: params.channel ?? "",
      gatewayClientScopes: params.gatewayClientScopes,
    }),
    cfg: params.cfg,
    origin: { accountId: params.accountId, channelId: params.channelId },
    target: params.target,
  });
  if (writeAuth.allowed) {
    return null;
  }
  return formatConfigWriteDeniedMessage({
    fallbackChannelId: params.channelId,
    result: writeAuth,
  });
}
