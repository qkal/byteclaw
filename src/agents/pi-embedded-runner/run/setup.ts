import type { OpenClawConfig } from "../../../config/config.js";
import type {
  PluginHookBeforeAgentStartResult,
  ProviderRuntimeModel,
} from "../../../plugins/types.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  type ContextWindowInfo,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { FailoverError } from "../../failover-error.js";
import { log } from "../logger.js";
import { readPiModelContextTokens } from "../model-context-tokens.js";

interface HookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId: string;
  workspaceDir: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}

interface HookRunnerLike {
  hasHooks(hookName: string): boolean;
  runBeforeModelResolve(
    input: { prompt: string },
    context: HookContext,
  ): Promise<{ providerOverride?: string; modelOverride?: string } | undefined>;
  runBeforeAgentStart(
    input: { prompt: string },
    context: HookContext,
  ): Promise<PluginHookBeforeAgentStartResult | undefined>;
}

export async function resolveHookModelSelection(params: {
  prompt: string;
  provider: string;
  modelId: string;
  hookRunner?: HookRunnerLike | null;
  hookContext: HookContext;
}) {
  let {provider} = params;
  let {modelId} = params;
  let modelResolveOverride: { providerOverride?: string; modelOverride?: string } | undefined;
  let legacyBeforeAgentStartResult: PluginHookBeforeAgentStartResult | undefined;
  const {hookRunner} = params;

  // Run before_model_resolve hooks early so plugins can override the
  // Provider/model before resolveModel().
  //
  // Legacy compatibility: before_agent_start is also checked for override
  // Fields if present. New hook takes precedence when both are set.
  if (hookRunner?.hasHooks("before_model_resolve")) {
    try {
      modelResolveOverride = await hookRunner.runBeforeModelResolve(
        { prompt: params.prompt },
        params.hookContext,
      );
    } catch (error) {
      log.warn(`before_model_resolve hook failed: ${String(error)}`);
    }
  }

  if (hookRunner?.hasHooks("before_agent_start")) {
    try {
      legacyBeforeAgentStartResult = await hookRunner.runBeforeAgentStart(
        { prompt: params.prompt },
        params.hookContext,
      );
      modelResolveOverride = {
        modelOverride:
          modelResolveOverride?.modelOverride ?? legacyBeforeAgentStartResult?.modelOverride,
        providerOverride:
          modelResolveOverride?.providerOverride ?? legacyBeforeAgentStartResult?.providerOverride,
      };
    } catch (error) {
      log.warn(`before_agent_start hook (legacy model resolve path) failed: ${String(error)}`);
    }
  }

  if (modelResolveOverride?.providerOverride) {
    provider = modelResolveOverride.providerOverride;
    log.info(`[hooks] provider overridden to ${provider}`);
  }
  if (modelResolveOverride?.modelOverride) {
    modelId = modelResolveOverride.modelOverride;
    log.info(`[hooks] model overridden to ${modelId}`);
  }

  return {
    legacyBeforeAgentStartResult,
    modelId,
    provider,
  };
}

export function resolveEffectiveRuntimeModel(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  runtimeModel: ProviderRuntimeModel;
}): {
  ctxInfo: ContextWindowInfo;
  effectiveModel: ProviderRuntimeModel;
} {
  const ctxInfo = resolveContextWindowInfo({
    cfg: params.cfg,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
    modelContextTokens: readPiModelContextTokens(params.runtimeModel),
    modelContextWindow: params.runtimeModel.contextWindow,
    modelId: params.modelId,
    provider: params.provider,
  });

  // Apply contextTokens cap to model so pi-coding-agent's auto-compaction
  // Threshold uses the effective limit, not the native context window.
  const effectiveModel =
    ctxInfo.tokens < (params.runtimeModel.contextWindow ?? Infinity)
      ? { ...params.runtimeModel, contextWindow: ctxInfo.tokens }
      : params.runtimeModel;
  const ctxGuard = evaluateContextWindowGuard({
    hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
    info: ctxInfo,
    warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  });
  if (ctxGuard.shouldWarn) {
    log.warn(
      `low context window: ${params.provider}/${params.modelId} ctx=${ctxGuard.tokens} (warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
    );
  }
  if (ctxGuard.shouldBlock) {
    log.error(
      `blocked model (context window too small): ${params.provider}/${params.modelId} ctx=${ctxGuard.tokens} (min=${CONTEXT_WINDOW_HARD_MIN_TOKENS}) source=${ctxGuard.source}`,
    );
    throw new FailoverError(
      `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
      { model: params.modelId, provider: params.provider, reason: "unknown" },
    );
  }

  return {
    ctxInfo,
    effectiveModel,
  };
}
