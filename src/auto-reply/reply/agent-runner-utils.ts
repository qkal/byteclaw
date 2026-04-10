import { resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getAgentRuntimeCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import { type OpenClawConfig, getRuntimeConfigSnapshot } from "../../config/config.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import type { TemplateContext } from "../templating.js";
import {
  resolveProviderScopedAuthProfile,
  resolveRunAuthProfile,
} from "./agent-runner-auth-profile.js";
export { resolveProviderScopedAuthProfile, resolveRunAuthProfile };
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;

export function resolveQueuedReplyRuntimeConfig(config: OpenClawConfig): OpenClawConfig {
  return (
    (typeof getRuntimeConfigSnapshot === "function" ? getRuntimeConfigSnapshot() : null) ?? config
  );
}

export async function resolveQueuedReplyExecutionConfig(
  config: OpenClawConfig,
): Promise<OpenClawConfig> {
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(config);
  const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
    commandName: "reply",
    config: runtimeConfig,
    targetIds: getAgentRuntimeCommandSecretTargetIds(),
  });
  return resolvedConfig ?? runtimeConfig;
}

/**
 * Build provider-specific threading context for tool auto-injection.
 */
export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: OpenClawConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): ChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  const originProvider = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Provider,
  });
  const originTo = resolveOriginMessageTo({
    originatingTo: sessionCtx.OriginatingTo,
    to: sessionCtx.To,
  });
  if (!config) {
    return {
      currentMessageId,
    };
  }
  const rawProvider = normalizeOptionalLowercaseString(originProvider);
  if (!rawProvider) {
    return {
      currentMessageId,
    };
  }
  const provider = normalizeChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
  // Fallback for unrecognized/plugin channels (e.g., BlueBubbles before plugin registry init)
  const threading = provider ? getChannelPlugin(provider)?.threading : undefined;
  if (!threading?.buildToolContext) {
    return {
      currentChannelId: normalizeOptionalString(originTo),
      currentChannelProvider: provider ?? (rawProvider as ChannelId),
      currentMessageId,
      hasRepliedRef,
    };
  }
  const context =
    threading.buildToolContext({
      accountId: sessionCtx.AccountId,
      cfg: config,
      context: {
        Channel: originProvider,
        ChatType: sessionCtx.ChatType,
        CurrentMessageId: currentMessageId,
        From: sessionCtx.From,
        MessageThreadId: sessionCtx.MessageThreadId,
        NativeChannelId: sessionCtx.NativeChannelId,
        ReplyToId: sessionCtx.ReplyToId,
        ThreadLabel: sessionCtx.ThreadLabel,
        To: originTo,
      },
      hasRepliedRef,
    }) ?? {};
  return {
    ...context,
    currentChannelProvider: provider!, // Guaranteed non-null since threading exists
    currentMessageId: context.currentMessageId ?? currentMessageId,
  };
}

export const isBunFetchSocketError = (message?: string) =>
  Boolean(message && BUN_FETCH_SOCKET_ERROR_RE.test(message));

export const formatBunFetchSocketError = (message: string) => {
  const trimmed = message.trim();
  return [
    "⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
    "```",
    trimmed || "Unknown error",
    "```",
  ].join("\n");
};

export const resolveEnforceFinalTag = (
  run: FollowupRun["run"],
  provider: string,
  model = run.model,
) =>
  Boolean(
    (run.skipProviderRuntimeHints ? false : undefined) ??
    (run.enforceFinalTag ||
      isReasoningTagProvider(provider, {
        config: run.config,
        modelId: model,
        workspaceDir: run.workspaceDir,
      })),
  );

export function resolveModelFallbackOptions(run: FollowupRun["run"]) {
  const {config} = run;
  return {
    agentDir: run.agentDir,
    cfg: config,
    fallbacksOverride: resolveRunModelFallbacksOverride({
      agentId: run.agentId,
      cfg: config,
      sessionKey: run.sessionKey,
    }),
    model: run.model,
    provider: run.provider,
  };
}

export function buildEmbeddedRunBaseParams(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  runId: string;
  authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
  allowTransientCooldownProbe?: boolean;
}) {
  const {config} = params.run;
  return {
    sessionFile: params.run.sessionFile,
    workspaceDir: params.run.workspaceDir,
    agentDir: params.run.agentDir,
    config,
    skillsSnapshot: params.run.skillsSnapshot,
    ownerNumbers: params.run.ownerNumbers,
    inputProvenance: params.run.inputProvenance,
    senderIsOwner: params.run.senderIsOwner,
    enforceFinalTag: resolveEnforceFinalTag(params.run, params.provider, params.model),
    silentExpected: params.run.silentExpected,
    provider: params.provider,
    model: params.model,
    ...params.authProfile,
    thinkLevel: params.run.thinkLevel,
    verboseLevel: params.run.verboseLevel,
    reasoningLevel: params.run.reasoningLevel,
    execOverrides: params.run.execOverrides,
    bashElevated: params.run.bashElevated,
    timeoutMs: params.run.timeoutMs,
    runId: params.runId,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  };
}

export function buildEmbeddedContextFromTemplate(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
}) {
  const {config} = params.run;
  return {
    sessionId: params.run.sessionId,
    sessionKey: params.run.sessionKey,
    agentId: params.run.agentId,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.sessionCtx.OriginatingChannel,
      provider: params.sessionCtx.Provider,
    }),
    agentAccountId: params.sessionCtx.AccountId,
    messageTo: resolveOriginMessageTo({
      originatingTo: params.sessionCtx.OriginatingTo,
      to: params.sessionCtx.To,
    }),
    messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
    // Provider threading context for tool auto-injection
    ...buildThreadingToolContext({
      config,
      hasRepliedRef: params.hasRepliedRef,
      sessionCtx: params.sessionCtx,
    }),
  };
}

export function buildTemplateSenderContext(sessionCtx: TemplateContext) {
  return {
    senderE164: normalizeOptionalString(sessionCtx.SenderE164),
    senderId: normalizeOptionalString(sessionCtx.SenderId),
    senderName: normalizeOptionalString(sessionCtx.SenderName),
    senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
  };
}

export function buildEmbeddedRunContexts(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
}) {
  return {
    authProfile: resolveRunAuthProfile(params.run, params.provider),
    embeddedContext: buildEmbeddedContextFromTemplate({
      hasRepliedRef: params.hasRepliedRef,
      run: params.run,
      sessionCtx: params.sessionCtx,
    }),
    senderContext: buildTemplateSenderContext(params.sessionCtx),
  };
}

export function buildEmbeddedRunExecutionParams(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
  model: string;
  runId: string;
  allowTransientCooldownProbe?: boolean;
}) {
  const { authProfile, embeddedContext, senderContext } = buildEmbeddedRunContexts(params);
  const runBaseParams = buildEmbeddedRunBaseParams({
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
    authProfile,
    model: params.model,
    provider: params.provider,
    run: params.run,
    runId: params.runId,
  });
  return {
    embeddedContext,
    runBaseParams,
    senderContext,
  };
}
