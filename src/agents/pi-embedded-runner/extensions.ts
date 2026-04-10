import type { ExtensionFactory, SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderRuntimeModel } from "../../plugins/types.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { setCompactionSafeguardRuntime } from "../pi-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-hooks/compaction-safeguard.js";
import contextPruningExtension from "../pi-hooks/context-pruning.js";
import { setContextPruningRuntime } from "../pi-hooks/context-pruning/runtime.js";
import { computeEffectiveSettings } from "../pi-hooks/context-pruning/settings.js";
import { makeToolPrunablePredicate } from "../pi-hooks/context-pruning/tools.js";
import { ensurePiCompactionReserveTokens } from "../pi-settings.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "./cache-ttl.js";

function resolveContextWindowTokens(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
}): number {
  return resolveContextWindowInfo({
    cfg: params.cfg,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
    modelContextTokens: params.model?.contextTokens,
    modelContextWindow: params.model?.contextWindow,
    modelId: params.modelId,
    provider: params.provider,
  }).tokens;
}

function buildContextPruningFactory(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
}): ExtensionFactory | undefined {
  const raw = params.cfg?.agents?.defaults?.contextPruning;
  if (raw?.mode !== "cache-ttl") {
    return undefined;
  }
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId, params.model?.api)) {
    return undefined;
  }

  const settings = computeEffectiveSettings(raw);
  if (!settings) {
    return undefined;
  }
  const transcriptPolicy = resolveTranscriptPolicy({
    modelApi: params.model?.api,
    modelId: params.modelId,
    provider: params.provider,
  });

  setContextPruningRuntime(params.sessionManager, {
    contextWindowTokens: resolveContextWindowTokens(params),
    dropThinkingBlocks: transcriptPolicy.dropThinkingBlocks,
    isToolPrunable: makeToolPrunablePredicate(settings.tools),
    lastCacheTouchAt: readLastCacheTtlTimestamp(params.sessionManager, {
      modelId: params.modelId,
      provider: params.provider,
    }),
    settings,
  });

  return contextPruningExtension;
}

function resolveCompactionMode(cfg?: OpenClawConfig): "default" | "safeguard" {
  const compaction = cfg?.agents?.defaults?.compaction;
  // A registered compaction provider requires the safeguard extension path
  if (compaction?.provider) {
    return "safeguard";
  }
  return compaction?.mode === "safeguard" ? "safeguard" : "default";
}

export function buildEmbeddedExtensionFactories(params: {
  cfg: OpenClawConfig | undefined;
  sessionManager: SessionManager;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel | undefined;
}): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  if (resolveCompactionMode(params.cfg) === "safeguard") {
    const compactionCfg = params.cfg?.agents?.defaults?.compaction;
    const qualityGuardCfg = compactionCfg?.qualityGuard;
    const contextWindowInfo = resolveContextWindowInfo({
      cfg: params.cfg,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
      modelContextTokens: params.model?.contextTokens,
      modelContextWindow: params.model?.contextWindow,
      modelId: params.modelId,
      provider: params.provider,
    });
    setCompactionSafeguardRuntime(params.sessionManager, {
      contextWindowTokens: contextWindowInfo.tokens,
      customInstructions: compactionCfg?.customInstructions,
      identifierInstructions: compactionCfg?.identifierInstructions,
      identifierPolicy: compactionCfg?.identifierPolicy,
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      model: params.model,
      provider: compactionCfg?.provider,
      qualityGuardEnabled: qualityGuardCfg?.enabled ?? false,
      qualityGuardMaxRetries: qualityGuardCfg?.maxRetries,
      recentTurnsPreserve: compactionCfg?.recentTurnsPreserve,
    });
    factories.push(compactionSafeguardExtension);
  }
  const pruningFactory = buildContextPruningFactory(params);
  if (pruningFactory) {
    factories.push(pruningFactory);
  }
  return factories;
}

export { ensurePiCompactionReserveTokens };
