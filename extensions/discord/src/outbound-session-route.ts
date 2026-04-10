import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type RoutePeer,
  buildOutboundBaseSessionKey,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
} from "openclaw/plugin-sdk/routing";
import { parseDiscordTarget } from "./target-parsing.js";

export interface ResolveDiscordOutboundSessionRouteParams {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { kind: string };
  replyToId?: string | null;
  threadId?: string | number | null;
}

export function resolveDiscordOutboundSessionRoute(
  params: ResolveDiscordOutboundSessionRouteParams,
) {
  const parsed = parseDiscordTarget(params.target, {
    defaultKind: resolveDiscordOutboundTargetKindHint(params),
  });
  if (!parsed) {
    return null;
  }
  const isDm = parsed.kind === "user";
  const peer: RoutePeer = {
    id: parsed.id,
    kind: isDm ? "direct" : "channel",
  };
  const baseSessionKey = buildOutboundBaseSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "discord",
    peer,
  });
  const explicitThreadId = normalizeOutboundThreadId(params.threadId);
  const threadCandidate = explicitThreadId ?? normalizeOutboundThreadId(params.replyToId);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadCandidate,
    useSuffix: false,
  });
  return {
    baseSessionKey,
    chatType: isDm ? ("direct" as const) : ("channel" as const),
    from: isDm ? `discord:${parsed.id}` : `discord:channel:${parsed.id}`,
    peer,
    sessionKey: threadKeys.sessionKey,
    threadId: explicitThreadId ?? undefined,
    to: isDm ? `user:${parsed.id}` : `channel:${parsed.id}`,
  };
}

function resolveDiscordOutboundTargetKindHint(params: {
  target: string;
  resolvedTarget?: { kind: string };
}): "user" | "channel" | undefined {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user") {
    return "user";
  }
  if (resolvedKind === "group" || resolvedKind === "channel") {
    return "channel";
  }

  const target = params.target.trim();
  if (/^channel:/i.test(target)) {
    return "channel";
  }
  if (/^(user:|discord:|@|<@!?)/i.test(target)) {
    return "user";
  }
  return undefined;
}
