import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type EmbeddingProviderRuntime,
  resolveEmbeddingProviderFallbackModel,
} from "./embeddings.js";

export interface MemoryResolvedProviderState {
  provider: EmbeddingProvider | null;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  providerRuntime?: EmbeddingProviderRuntime;
}

export function resolveMemoryPrimaryProviderRequest(params: {
  settings: ResolvedMemorySearchConfig;
}): {
  provider: string;
  model: string;
  remote: ResolvedMemorySearchConfig["remote"];
  outputDimensionality: ResolvedMemorySearchConfig["outputDimensionality"];
  fallback: ResolvedMemorySearchConfig["fallback"];
  local: ResolvedMemorySearchConfig["local"];
} {
  return {
    fallback: params.settings.fallback,
    local: params.settings.local,
    model: params.settings.model,
    outputDimensionality: params.settings.outputDimensionality,
    provider: params.settings.provider,
    remote: params.settings.remote,
  };
}

export function resolveMemoryProviderState(
  result: Pick<
    EmbeddingProviderResult,
    "provider" | "fallbackFrom" | "fallbackReason" | "providerUnavailableReason" | "runtime"
  >,
): MemoryResolvedProviderState {
  return {
    fallbackFrom: result.fallbackFrom,
    fallbackReason: result.fallbackReason,
    provider: result.provider,
    providerRuntime: result.runtime,
    providerUnavailableReason: result.providerUnavailableReason,
  };
}

export function applyMemoryFallbackProviderState(params: {
  current: MemoryResolvedProviderState;
  fallbackFrom: string;
  reason: string;
  result: Pick<EmbeddingProviderResult, "provider" | "runtime">;
}): MemoryResolvedProviderState {
  return {
    ...params.current,
    fallbackFrom: params.fallbackFrom,
    fallbackReason: params.reason,
    provider: params.result.provider,
    providerRuntime: params.result.runtime,
  };
}

export function resolveMemoryFallbackProviderRequest(params: {
  cfg: OpenClawConfig;
  settings: ResolvedMemorySearchConfig;
  currentProviderId: string | null;
}): {
  provider: string;
  model: string;
  remote: ResolvedMemorySearchConfig["remote"];
  outputDimensionality: ResolvedMemorySearchConfig["outputDimensionality"];
  fallback: "none";
  local: ResolvedMemorySearchConfig["local"];
} | null {
  const {fallback} = params.settings;
  if (
    !fallback ||
    fallback === "none" ||
    !params.currentProviderId ||
    fallback === params.currentProviderId
  ) {
    return null;
  }
  return {
    fallback: "none",
    local: params.settings.local,
    model: resolveEmbeddingProviderFallbackModel(fallback, params.settings.model, params.cfg),
    outputDimensionality: params.settings.outputDimensionality,
    provider: fallback,
    remote: params.settings.remote,
  };
}
