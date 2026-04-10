import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { missingTargetError } from "./target-errors.js";

export type OutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

export interface ResolveOutboundTargetParams {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}

function buildWebChatDeliveryError(): Error {
  return new Error(
    `Delivering to WebChat is not supported via \`${formatCliCommand("openclaw agent")}\`; use WhatsApp/Telegram or run with --deliver=false.`,
  );
}

export function resolveOutboundTargetWithPlugin(params: {
  plugin: ChannelPlugin | undefined;
  target: ResolveOutboundTargetParams;
  onMissingPlugin?: () => OutboundTargetResolution | undefined;
}): OutboundTargetResolution | undefined {
  if (params.target.channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      error: buildWebChatDeliveryError(),
      ok: false,
    };
  }

  const { plugin } = params;
  if (!plugin) {
    return params.onMissingPlugin?.();
  }

  const allowFromRaw =
    params.target.allowFrom ??
    (params.target.cfg && plugin.config.resolveAllowFrom
      ? plugin.config.resolveAllowFrom({
          accountId: params.target.accountId ?? undefined,
          cfg: params.target.cfg,
        })
      : undefined);
  const allowFrom = allowFromRaw ? mapAllowFromEntries(allowFromRaw) : undefined;

  const effectiveTo =
    params.target.to?.trim() ||
    (params.target.cfg && plugin.config.resolveDefaultTo
      ? plugin.config.resolveDefaultTo({
          accountId: params.target.accountId ?? undefined,
          cfg: params.target.cfg,
        })
      : undefined);

  const resolveTarget = plugin.outbound?.resolveTarget;
  if (resolveTarget) {
    return resolveTarget({
      accountId: params.target.accountId ?? undefined,
      allowFrom,
      cfg: params.target.cfg,
      mode: params.target.mode ?? "explicit",
      to: effectiveTo,
    });
  }

  if (effectiveTo) {
    return { ok: true, to: effectiveTo };
  }
  const hint = plugin.messaging?.targetResolver?.hint;
  return {
    error: missingTargetError(plugin.meta.label ?? params.target.channel, hint),
    ok: false,
  };
}
