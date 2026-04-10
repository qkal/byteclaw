import { getChannelPlugin, resolveChannelApprovalCapability } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

export interface ApprovalCommandAuthorization {
  authorized: boolean;
  reason?: string;
  explicit: boolean;
}

export function resolveApprovalCommandAuthorization(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  kind: "exec" | "plugin";
}): ApprovalCommandAuthorization {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return { authorized: true, explicit: false };
  }
  const approvalCapability = resolveChannelApprovalCapability(getChannelPlugin(channel));
  const resolved = approvalCapability?.authorizeActorAction?.({
    accountId: params.accountId,
    action: "approve",
    approvalKind: params.kind,
    cfg: params.cfg,
    senderId: params.senderId,
  });
  if (!resolved) {
    return { authorized: true, explicit: false };
  }
  const availability = approvalCapability?.getActionAvailabilityState?.({
    accountId: params.accountId,
    action: "approve",
    approvalKind: params.kind,
    cfg: params.cfg,
  });
  return {
    authorized: resolved.authorized,
    explicit: resolved.authorized ? availability?.kind !== "disabled" : true,
    reason: resolved.reason,
  };
}
