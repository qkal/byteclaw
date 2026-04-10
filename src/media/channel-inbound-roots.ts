import type { MsgContext } from "../auto-reply/templating.js";
import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

function findChannelMessagingAdapter(channelId?: string | null) {
  const normalized = normalizeOptionalLowercaseString(channelId);
  if (!normalized) {
    return undefined;
  }
  return getBootstrapChannelPlugin(normalized)?.messaging;
}

export function resolveChannelInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const messaging = findChannelMessagingAdapter(params.ctx.Surface ?? params.ctx.Provider);
  return messaging?.resolveInboundAttachmentRoots?.({
    accountId: params.ctx.AccountId,
    cfg: params.cfg,
  });
}

export function resolveChannelRemoteInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const messaging = findChannelMessagingAdapter(params.ctx.Surface ?? params.ctx.Provider);
  return messaging?.resolveRemoteInboundAttachmentRoots?.({
    accountId: params.ctx.AccountId,
    cfg: params.cfg,
  });
}
