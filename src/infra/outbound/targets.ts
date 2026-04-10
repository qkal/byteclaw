import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { type ChatType, normalizeChatType } from "../../channels/chat-type.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
} from "../../utils/delivery-context.js";
import type {
  DeliverableMessageChannel,
  GatewayMessageChannel,
} from "../../utils/message-channel.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
} from "../../utils/message-channel.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
} from "./channel-resolution.js";
import {
  type OutboundTargetResolution,
  resolveOutboundTargetWithPlugin,
} from "./targets-resolve-shared.js";

export type OutboundChannel = DeliverableMessageChannel;

export type HeartbeatTarget = OutboundChannel;

export interface OutboundTarget {
  channel: OutboundChannel;
  to?: string;
  reason?: string;
  accountId?: string;
  threadId?: string | number;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
}

export interface HeartbeatSenderContext {
  sender: string;
  provider?: DeliverableMessageChannel;
  allowFrom: string[];
}

export type { OutboundTargetResolution } from "./targets-resolve-shared.js";
export { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";
import { resolveSessionDeliveryTarget } from "./targets-session.js";

// Channel docking: prefer plugin.outbound.resolveTarget + allowFrom to normalize destinations.
export function resolveOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution {
  return (
    resolveOutboundTargetWithPlugin({
      onMissingPlugin: () =>
        params.channel === INTERNAL_MESSAGE_CHANNEL
          ? undefined
          : {
              error: new Error(`Unsupported channel: ${params.channel}`),
              ok: false,
            },
      plugin: resolveOutboundChannelPlugin({
        cfg: params.cfg,
        channel: params.channel,
      }),
      target: params,
    }) ?? {
      error: new Error(`Unsupported channel: ${params.channel}`),
      ok: false,
    }
  );
}

export function resolveHeartbeatDeliveryTarget(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  turnSource?: DeliveryContext;
}): OutboundTarget {
  const { cfg, entry } = params;
  const heartbeat = params.heartbeat ?? cfg.agents?.defaults?.heartbeat;
  const rawTarget = heartbeat?.target;
  let target: HeartbeatTarget = "none";
  if (rawTarget === "none" || rawTarget === "last") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeDeliverableOutboundChannel(rawTarget);
    if (normalized) {
      target = normalized;
    }
  }

  if (target === "none") {
    const base = resolveSessionDeliveryTarget({ entry });
    return buildNoHeartbeatDeliveryTarget({
      lastAccountId: base.lastAccountId,
      lastChannel: base.lastChannel,
      reason: "target-none",
    });
  }

  const resolvedTurnSource =
    target === "last"
      ? mergeDeliveryContext(params.turnSource, deliveryContextFromSession(entry))
      : undefined;

  const resolvedTarget = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: target === "last" ? "last" : target,
    explicitTo: heartbeat?.to,
    mode: "heartbeat",
    turnSourceChannel:
      resolvedTurnSource?.channel && isDeliverableMessageChannel(resolvedTurnSource.channel)
        ? resolvedTurnSource.channel
        : undefined,
    turnSourceTo: resolvedTurnSource?.to,
    turnSourceAccountId: resolvedTurnSource?.accountId,
    // Only pass threadId from an explicit turn source (e.g., restart sentinel's
    // Delivery context). Do NOT fall back to session-stored threadId here —
    // Heartbeat mode intentionally drops inherited thread IDs to avoid replying
    // In stale threads (e.g., Slack thread_ts). The sentinel's delivery context
    // Carries the correct topic/thread ID when present.
    turnSourceThreadId: params.turnSource?.threadId,
  });

  const heartbeatAccountId = heartbeat?.accountId?.trim();
  // Use explicit accountId from heartbeat config if provided, otherwise fall back to session
  let effectiveAccountId = heartbeatAccountId || resolvedTarget.accountId;

  if (heartbeatAccountId && resolvedTarget.channel) {
    const plugin = resolveOutboundChannelPlugin({
      cfg,
      channel: resolvedTarget.channel,
    });
    const listAccountIds = plugin?.config.listAccountIds;
    const accountIds = listAccountIds ? listAccountIds(cfg) : [];
    if (accountIds.length > 0) {
      const normalizedAccountId = normalizeAccountId(heartbeatAccountId);
      const normalizedAccountIds = new Set(
        accountIds.map((accountId) => normalizeAccountId(accountId)),
      );
      if (!normalizedAccountIds.has(normalizedAccountId)) {
        return buildNoHeartbeatDeliveryTarget({
          accountId: normalizedAccountId,
          lastAccountId: resolvedTarget.lastAccountId,
          lastChannel: resolvedTarget.lastChannel,
          reason: "unknown-account",
        });
      }
      effectiveAccountId = normalizedAccountId;
    }
  }

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return buildNoHeartbeatDeliveryTarget({
      accountId: effectiveAccountId,
      lastAccountId: resolvedTarget.lastAccountId,
      lastChannel: resolvedTarget.lastChannel,
      reason: "no-target",
    });
  }

  const resolved = resolveOutboundTarget({
    accountId: effectiveAccountId,
    cfg,
    channel: resolvedTarget.channel,
    mode: "heartbeat",
    to: resolvedTarget.to,
  });
  if (!resolved.ok) {
    return buildNoHeartbeatDeliveryTarget({
      accountId: effectiveAccountId,
      lastAccountId: resolvedTarget.lastAccountId,
      lastChannel: resolvedTarget.lastChannel,
      reason: "no-target",
    });
  }

  const sessionChatTypeHint =
    target === "last" && !heartbeat?.to ? normalizeChatType(entry?.chatType) : undefined;
  const deliveryChatType = resolveHeartbeatDeliveryChatType({
    channel: resolvedTarget.channel,
    sessionChatType: sessionChatTypeHint,
    to: resolved.to,
  });
  if (deliveryChatType === "direct" && heartbeat?.directPolicy === "block") {
    return buildNoHeartbeatDeliveryTarget({
      accountId: effectiveAccountId,
      lastAccountId: resolvedTarget.lastAccountId,
      lastChannel: resolvedTarget.lastChannel,
      reason: "dm-blocked",
    });
  }

  let reason: string | undefined;
  const plugin = resolveOutboundChannelPlugin({
    cfg,
    channel: resolvedTarget.channel,
  });
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTarget({
      accountId: effectiveAccountId,
      cfg,
      channel: resolvedTarget.channel,
      mode: "explicit",
      to: resolvedTarget.to,
    });
    if (explicit.ok && explicit.to !== resolved.to) {
      reason = "allowFrom-fallback";
    }
  }

  return {
    accountId: effectiveAccountId,
    channel: resolvedTarget.channel,
    lastAccountId: resolvedTarget.lastAccountId,
    lastChannel: resolvedTarget.lastChannel,
    reason,
    threadId: resolvedTarget.threadId,
    to: resolved.to,
  };
}

function buildNoHeartbeatDeliveryTarget(params: {
  reason: string;
  accountId?: string;
  lastChannel?: DeliverableMessageChannel;
  lastAccountId?: string;
}): OutboundTarget {
  return {
    accountId: params.accountId,
    channel: "none",
    lastAccountId: params.lastAccountId,
    lastChannel: params.lastChannel,
    reason: params.reason,
  };
}

function inferChatTypeFromTarget(params: {
  channel: DeliverableMessageChannel;
  to: string;
}): ChatType | undefined {
  const to = params.to.trim();
  if (!to) {
    return undefined;
  }

  if (/^user:/i.test(to)) {
    return "direct";
  }
  if (/^(channel:|thread:)/i.test(to)) {
    return "channel";
  }
  if (/^group:/i.test(to)) {
    return "group";
  }
  return (
    resolveOutboundChannelPlugin({
      channel: params.channel,
    })?.messaging?.inferTargetChatType?.({ to }) ?? undefined
  );
}

function resolveHeartbeatDeliveryChatType(params: {
  channel: DeliverableMessageChannel;
  to: string;
  sessionChatType?: ChatType;
}): ChatType | undefined {
  if (params.sessionChatType) {
    return params.sessionChatType;
  }
  return inferChatTypeFromTarget({
    channel: params.channel,
    to: params.to,
  });
}

function resolveHeartbeatSenderId(params: {
  allowFrom: (string | number)[];
  deliveryTo?: string;
  lastTo?: string;
  provider?: string | null;
}) {
  const { allowFrom, deliveryTo, lastTo, provider } = params;
  const candidates = [
    deliveryTo?.trim(),
    provider && deliveryTo ? `${provider}:${deliveryTo}` : undefined,
    lastTo?.trim(),
    provider && lastTo ? `${provider}:${lastTo}` : undefined,
  ].filter((val): val is string => Boolean(val?.trim()));

  const allowList = mapAllowFromEntries(allowFrom).filter((entry) => entry && entry !== "*");
  if (allowFrom.includes("*")) {
    return candidates[0] ?? "heartbeat";
  }
  if (candidates.length > 0 && allowList.length > 0) {
    const matched = candidates.find((candidate) => allowList.includes(candidate));
    if (matched) {
      return matched;
    }
  }
  if (candidates.length > 0 && allowList.length === 0) {
    return candidates[0];
  }
  if (allowList.length > 0) {
    return allowList[0];
  }
  return candidates[0] ?? "heartbeat";
}

export function resolveHeartbeatSenderContext(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  delivery: OutboundTarget;
}): HeartbeatSenderContext {
  const provider =
    params.delivery.channel !== "none" ? params.delivery.channel : params.delivery.lastChannel;
  const accountId =
    params.delivery.accountId ??
    (provider === params.delivery.lastChannel ? params.delivery.lastAccountId : undefined);
  const allowFromRaw = provider
    ? (resolveOutboundChannelPlugin({
        cfg: params.cfg,
        channel: provider,
      })?.config.resolveAllowFrom?.({
        accountId,
        cfg: params.cfg,
      }) ?? [])
    : [];
  const allowFrom = mapAllowFromEntries(allowFromRaw);

  const sender = resolveHeartbeatSenderId({
    allowFrom,
    deliveryTo: params.delivery.to,
    lastTo: params.entry?.lastTo,
    provider,
  });

  return { allowFrom, provider, sender };
}
