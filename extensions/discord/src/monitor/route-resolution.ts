import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  type ResolvedAgentRoute,
  type RoutePeer,
  deriveLastRoutePolicy,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";

export function buildDiscordRoutePeer(params: {
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string | null;
  conversationId: string;
}): RoutePeer {
  return {
    id: params.isDirectMessage
      ? params.directUserId?.trim() || params.conversationId
      : params.conversationId,
    kind: params.isDirectMessage ? "direct" : (params.isGroupDm ? "group" : "channel"),
  };
}

export function resolveDiscordConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  guildId?: string | null;
  memberRoleIds?: string[];
  peer: RoutePeer;
  parentConversationId?: string | null;
}): ResolvedAgentRoute {
  return resolveAgentRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "discord",
    guildId: params.guildId ?? undefined,
    memberRoleIds: params.memberRoleIds,
    parentPeer: params.parentConversationId
      ? { id: params.parentConversationId, kind: "channel" }
      : undefined,
    peer: params.peer,
  });
}

export function resolveDiscordBoundConversationRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  guildId?: string | null;
  memberRoleIds?: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string | null;
  conversationId: string;
  parentConversationId?: string | null;
  boundSessionKey?: string | null;
  configuredRoute?: { route: ResolvedAgentRoute } | null;
  matchedBy?: ResolvedAgentRoute["matchedBy"];
}): ResolvedAgentRoute {
  const route = resolveDiscordConversationRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    guildId: params.guildId,
    memberRoleIds: params.memberRoleIds,
    parentConversationId: params.parentConversationId,
    peer: buildDiscordRoutePeer({
      conversationId: params.conversationId,
      directUserId: params.directUserId,
      isDirectMessage: params.isDirectMessage,
      isGroupDm: params.isGroupDm,
    }),
  });
  return resolveDiscordEffectiveRoute({
    boundSessionKey: params.boundSessionKey,
    configuredRoute: params.configuredRoute,
    matchedBy: params.matchedBy,
    route,
  });
}

export function resolveDiscordEffectiveRoute(params: {
  route: ResolvedAgentRoute;
  boundSessionKey?: string | null;
  configuredRoute?: { route: ResolvedAgentRoute } | null;
  matchedBy?: ResolvedAgentRoute["matchedBy"];
}): ResolvedAgentRoute {
  const boundSessionKey = params.boundSessionKey?.trim();
  if (!boundSessionKey) {
    return params.configuredRoute?.route ?? params.route;
  }
  return {
    ...params.route,
    agentId: resolveAgentIdFromSessionKey(boundSessionKey),
    lastRoutePolicy: deriveLastRoutePolicy({
      mainSessionKey: params.route.mainSessionKey,
      sessionKey: boundSessionKey,
    }),
    sessionKey: boundSessionKey,
    ...(params.matchedBy ? { matchedBy: params.matchedBy } : {}),
  };
}
