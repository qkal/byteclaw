import { buildAgentSessionKey, deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";
import {
  type PluginRuntime,
  getSessionBindingService,
  resolveAgentIdFromSessionKey,
  resolveConfiguredAcpBindingRecord,
} from "../../runtime-api.js";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixThreadSessionKeys } from "./threads.js";

type MatrixResolvedRoute = ReturnType<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>;

function resolveMatrixDmSessionKey(params: {
  accountId: string;
  agentId: string;
  roomId: string;
  dmSessionScope?: "per-user" | "per-room";
  fallbackSessionKey: string;
}): string {
  if (params.dmSessionScope !== "per-room") {
    return params.fallbackSessionKey;
  }
  return buildAgentSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    channel: "matrix",
    peer: {
      id: params.roomId,
      kind: "channel",
    },
  });
}

function shouldApplyMatrixPerRoomDmSessionScope(params: {
  isDirectMessage: boolean;
  configuredSessionKey?: string;
}): boolean {
  return params.isDirectMessage && !params.configuredSessionKey;
}

export function resolveMatrixInboundRoute(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  senderId: string;
  isDirectMessage: boolean;
  dmSessionScope?: "per-user" | "per-room";
  threadId?: string;
  eventTs?: number;
  resolveAgentRoute: PluginRuntime["channel"]["routing"]["resolveAgentRoute"];
}): {
  route: MatrixResolvedRoute;
  configuredBinding: ReturnType<typeof resolveConfiguredAcpBindingRecord>;
  runtimeBindingId: string | null;
} {
  const baseRoute = params.resolveAgentRoute({
    cfg: params.cfg,
    channel: "matrix",
    accountId: params.accountId,
    peer: {
      id: params.isDirectMessage ? params.senderId : params.roomId,
      kind: params.isDirectMessage ? "direct" : "channel",
    },
    // Matrix DMs are still sender-addressed first, but the room ID remains a
    // Useful fallback binding key for generic route matching.
    parentPeer: params.isDirectMessage
      ? {
          id: params.roomId,
          kind: "channel",
        }
      : undefined,
  });
  const bindingConversationId = params.threadId ?? params.roomId;
  const bindingParentConversationId = params.threadId ? params.roomId : undefined;
  const sessionBindingService = getSessionBindingService();
  const runtimeBinding = sessionBindingService.resolveByConversation({
    accountId: params.accountId,
    channel: "matrix",
    conversationId: bindingConversationId,
    parentConversationId: bindingParentConversationId,
  });
  const boundSessionKey = runtimeBinding?.targetSessionKey?.trim();

  if (runtimeBinding && boundSessionKey) {
    return {
      configuredBinding: null,
      route: {
        ...baseRoute,
        agentId: resolveAgentIdFromSessionKey(boundSessionKey) || baseRoute.agentId,
        lastRoutePolicy: deriveLastRoutePolicy({
          mainSessionKey: baseRoute.mainSessionKey,
          sessionKey: boundSessionKey,
        }),
        matchedBy: "binding.channel",
        sessionKey: boundSessionKey,
      },
      runtimeBindingId: runtimeBinding.bindingId,
    };
  }

  const configuredBinding =
    runtimeBinding == null
      ? resolveConfiguredAcpBindingRecord({
          accountId: params.accountId,
          cfg: params.cfg,
          channel: "matrix",
          conversationId: bindingConversationId,
          parentConversationId: bindingParentConversationId,
        })
      : null;
  const configuredSessionKey = configuredBinding?.record.targetSessionKey?.trim();

  const effectiveRoute =
    configuredBinding && configuredSessionKey
      ? {
          ...baseRoute,
          agentId:
            resolveAgentIdFromSessionKey(configuredSessionKey) ||
            configuredBinding.spec.agentId ||
            baseRoute.agentId,
          lastRoutePolicy: deriveLastRoutePolicy({
            mainSessionKey: baseRoute.mainSessionKey,
            sessionKey: configuredSessionKey,
          }),
          matchedBy: "binding.channel" as const,
          sessionKey: configuredSessionKey,
        }
      : baseRoute;

  const dmSessionKey = shouldApplyMatrixPerRoomDmSessionScope({
    configuredSessionKey,
    isDirectMessage: params.isDirectMessage,
  })
    ? resolveMatrixDmSessionKey({
        accountId: params.accountId,
        agentId: effectiveRoute.agentId,
        dmSessionScope: params.dmSessionScope,
        fallbackSessionKey: effectiveRoute.sessionKey,
        roomId: params.roomId,
      })
    : effectiveRoute.sessionKey;
  const routeWithDmScope =
    dmSessionKey === effectiveRoute.sessionKey
      ? effectiveRoute
      : {
          ...effectiveRoute,
          lastRoutePolicy: "session" as const,
          sessionKey: dmSessionKey,
        };

  // When no binding overrides the session key, isolate threads into their own sessions.
  if (!configuredBinding && !configuredSessionKey && params.threadId) {
    const threadKeys = resolveMatrixThreadSessionKeys({
      baseSessionKey: routeWithDmScope.sessionKey,
      parentSessionKey: routeWithDmScope.sessionKey,
      threadId: params.threadId,
    });
    return {
      configuredBinding,
      route: {
        ...routeWithDmScope,
        lastRoutePolicy: deriveLastRoutePolicy({
          mainSessionKey: threadKeys.parentSessionKey ?? routeWithDmScope.sessionKey,
          sessionKey: threadKeys.sessionKey,
        }),
        mainSessionKey: threadKeys.parentSessionKey ?? routeWithDmScope.sessionKey,
        sessionKey: threadKeys.sessionKey,
      },
      runtimeBindingId: null,
    };
  }

  return {
    configuredBinding,
    route: routeWithDmScope,
    runtimeBindingId: null,
  };
}
