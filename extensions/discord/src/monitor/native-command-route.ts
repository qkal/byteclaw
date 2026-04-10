import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  resolveDiscordBoundConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import type { ThreadBindingRecord } from "./thread-bindings.js";

type ResolvedConfiguredBindingRoute = ReturnType<
  typeof conversationRuntime.resolveConfiguredBindingRoute
>;
type ConfiguredBindingResolution = NonNullable<
  NonNullable<ResolvedConfiguredBindingRoute>["bindingResolution"]
>;

export interface DiscordNativeInteractionRouteState {
  route: ResolvedAgentRoute;
  effectiveRoute: ResolvedAgentRoute;
  boundSessionKey?: string;
  configuredRoute: ResolvedConfiguredBindingRoute | null;
  configuredBinding: ConfiguredBindingResolution | null;
  bindingReadiness: Awaited<
    ReturnType<typeof conversationRuntime.ensureConfiguredBindingRouteReady>
  > | null;
}

export async function resolveDiscordNativeInteractionRouteState(params: {
  cfg: OpenClawConfig;
  accountId: string;
  guildId?: string;
  memberRoleIds?: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  directUserId?: string;
  conversationId: string;
  parentConversationId?: string;
  threadBinding?: ThreadBindingRecord;
  enforceConfiguredBindingReadiness?: boolean;
}): Promise<DiscordNativeInteractionRouteState> {
  const route = resolveDiscordBoundConversationRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    conversationId: params.conversationId,
    directUserId: params.directUserId,
    guildId: params.guildId,
    isDirectMessage: params.isDirectMessage,
    isGroupDm: params.isGroupDm,
    memberRoleIds: params.memberRoleIds,
    parentConversationId: params.parentConversationId,
  });
  const configuredRoute =
    params.threadBinding == null
      ? conversationRuntime.resolveConfiguredBindingRoute({
          cfg: params.cfg,
          conversation: {
            accountId: params.accountId,
            channel: "discord",
            conversationId: params.conversationId,
            parentConversationId: params.parentConversationId,
          },
          route,
        })
      : null;
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  const configuredBoundSessionKey = normalizeOptionalString(configuredRoute?.boundSessionKey);
  const boundSessionKey =
    normalizeOptionalString(params.threadBinding?.targetSessionKey) ?? configuredBoundSessionKey;
  const effectiveRoute = resolveDiscordEffectiveRoute({
    boundSessionKey,
    configuredRoute,
    matchedBy: configuredBinding ? "binding.channel" : undefined,
    route,
  });
  const bindingReadiness =
    params.enforceConfiguredBindingReadiness && configuredBinding
      ? await conversationRuntime.ensureConfiguredBindingRouteReady({
          bindingResolution: configuredBinding,
          cfg: params.cfg,
        })
      : null;
  return {
    bindingReadiness,
    boundSessionKey,
    configuredBinding,
    configuredRoute,
    effectiveRoute,
    route,
  };
}
