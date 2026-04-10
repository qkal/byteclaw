import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  recordSessionMetaFromInbound,
  resolveStorePath,
} from "../../config/sessions/inbound.runtime.js";
import { type RoutePeer, buildAgentSessionKey } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export interface OutboundSessionRoute {
  sessionKey: string;
  baseSessionKey: string;
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
}

export interface ResolveOutboundSessionRouteParams {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
  accountId?: string | null;
  target: string;
  currentSessionKey?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  replyToId?: string | null;
  threadId?: string | number | null;
}

function resolveOutboundChannelPlugin(channel: ChannelId) {
  return getChannelPlugin(channel);
}

function stripProviderPrefix(raw: string, channel: string): string {
  const trimmed = raw.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const prefix = `${normalizeLowercaseStringOrEmpty(channel)}:`;
  if (lower.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  return trimmed;
}

function stripKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}

function inferPeerKind(params: {
  channel: ChannelId;
  resolvedTarget?: ResolvedMessagingTarget;
}): ChatType {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "direct";
  }
  if (resolvedKind === "channel") {
    return "channel";
  }
  if (resolvedKind === "group") {
    const plugin = resolveOutboundChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    const supportsChannel = chatTypes.includes("channel");
    const supportsGroup = chatTypes.includes("group");
    if (supportsChannel && !supportsGroup) {
      return "channel";
    }
    return "group";
  }
  return "direct";
}

function buildBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: ChannelId;
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

function resolveFallbackSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripProviderPrefix(params.target, params.channel).trim();
  if (!trimmed) {
    return null;
  }
  const peerKind = inferPeerKind({
    channel: params.channel,
    resolvedTarget: params.resolvedTarget,
  });
  const peerId = stripKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = { id: peerId, kind: peerKind };
  const baseSessionKey = buildBaseSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: params.channel,
    peer,
  });
  const chatType = peerKind === "direct" ? "direct" : (peerKind === "channel" ? "channel" : "group");
  const from =
    peerKind === "direct"
      ? `${params.channel}:${peerId}`
      : `${params.channel}:${peerKind}:${peerId}`;
  const toPrefix = peerKind === "direct" ? "user" : "channel";
  return {
    baseSessionKey,
    chatType,
    from,
    peer,
    sessionKey: baseSessionKey,
    to: `${toPrefix}:${peerId}`,
  };
}

export async function resolveOutboundSessionRoute(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const target = params.target.trim();
  if (!target) {
    return null;
  }
  const nextParams = { ...params, target };
  const resolver = resolveOutboundChannelPlugin(params.channel)?.messaging
    ?.resolveOutboundSessionRoute;
  if (resolver) {
    return await resolver(nextParams);
  }
  return resolveFallbackSession(nextParams);
}

export async function ensureOutboundSessionEntry(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
}): Promise<void> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: resolveAgentIdFromSessionKey(params.route.sessionKey),
  });
  const ctx: MsgContext = {
    AccountId: params.accountId ?? undefined,
    ChatType: params.route.chatType,
    From: params.route.from,
    MessageThreadId: params.route.threadId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.route.to,
    Provider: params.channel,
    SessionKey: params.route.sessionKey,
    Surface: params.channel,
    To: params.route.to,
  };
  try {
    await recordSessionMetaFromInbound({
      ctx,
      sessionKey: params.route.sessionKey,
      storePath,
    });
  } catch {
    // Do not block outbound sends on session meta writes.
  }
}
