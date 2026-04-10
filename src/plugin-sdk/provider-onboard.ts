// Keep provider onboarding helpers dependency-light so bundled provider plugins
// Do not pull heavyweight runtime graphs at activation time.

import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveStaticAllowlistModelKey } from "../agents/model-ref-shared.js";
import { findNormalizedProviderKey } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";
import { resolvePrimaryStringValue } from "../shared/string-coerce.js";

export type { OpenClawConfig, ModelApi, ModelDefinitionConfig, ModelProviderConfig };
export {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";

export type AgentModelAliasEntry =
  | string
  | {
      modelRef: string;
      alias?: string;
    };

const LEGACY_OPENCODE_ZEN_DEFAULT_MODELS = new Set([
  "opencode/claude-opus-4-5",
  "opencode-zen/claude-opus-4-5",
]);

export const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";

export interface ProviderOnboardPresetAppliers<TArgs extends unknown[]> {
  applyProviderConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig;
  applyConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig;
}

function extractAgentDefaultModelFallbacks(model: unknown): string[] | undefined {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  if (!("fallbacks" in model)) {
    return undefined;
  }
  const { fallbacks } = model as { fallbacks?: unknown };
  return Array.isArray(fallbacks) ? fallbacks.map((value) => String(value)) : undefined;
}

function normalizeAgentModelAliasEntry(entry: AgentModelAliasEntry): {
  modelRef: string;
  alias?: string;
} {
  if (typeof entry === "string") {
    return { modelRef: entry };
  }
  return entry;
}

interface ProviderModelMergeState {
  providers: Record<string, ModelProviderConfig>;
  existingProvider?: ModelProviderConfig;
  existingModels: ModelDefinitionConfig[];
}

function resolveProviderModelMergeState(
  cfg: OpenClawConfig,
  providerId: string,
): ProviderModelMergeState {
  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProviderKey = findNormalizedProviderKey(providers, providerId);
  const existingProvider =
    existingProviderKey !== undefined
      ? (providers[existingProviderKey] as ModelProviderConfig | undefined)
      : undefined;
  const existingModels: ModelDefinitionConfig[] = Array.isArray(existingProvider?.models)
    ? existingProvider.models
    : [];
  if (existingProviderKey && existingProviderKey !== providerId) {
    delete providers[existingProviderKey];
  }
  return { existingModels, existingProvider, providers };
}

function buildProviderConfig(params: {
  existingProvider: ModelProviderConfig | undefined;
  api: ModelApi;
  baseUrl: string;
  mergedModels: ModelDefinitionConfig[];
  fallbackModels: ModelDefinitionConfig[];
}): ModelProviderConfig {
  const { apiKey: existingApiKey, ...existingProviderRest } = (params.existingProvider ?? {}) as {
    apiKey?: string;
  };
  const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : undefined;

  return {
    ...existingProviderRest,
    baseUrl: params.baseUrl,
    api: params.api,
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: params.mergedModels.length > 0 ? params.mergedModels : params.fallbackModels,
  };
}

function applyProviderConfigWithMergedModels(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    providerState: ProviderModelMergeState;
    api: ModelApi;
    baseUrl: string;
    mergedModels: ModelDefinitionConfig[];
    fallbackModels: ModelDefinitionConfig[];
  },
): OpenClawConfig {
  params.providerState.providers[params.providerId] = buildProviderConfig({
    api: params.api,
    baseUrl: params.baseUrl,
    existingProvider: params.providerState.existingProvider,
    fallbackModels: params.fallbackModels,
    mergedModels: params.mergedModels,
  });
  return applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels: params.agentModels,
    providers: params.providerState.providers,
  });
}

function createProviderPresetAppliers<
  TArgs extends unknown[],
  TParams extends {
    primaryModelRef?: string;
  },
>(params: {
  resolveParams: (
    cfg: OpenClawConfig,
    ...args: TArgs
  ) => Omit<TParams, "primaryModelRef"> | null | undefined;
  applyPreset: (cfg: OpenClawConfig, preset: TParams) => OpenClawConfig;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs> {
  return {
    applyConfig(cfg, ...args) {
      const resolved = params.resolveParams(cfg, ...args);
      if (!resolved) {
        return cfg;
      }
      return params.applyPreset(cfg, {
        ...(resolved as TParams),
        primaryModelRef: params.primaryModelRef,
      });
    },
    applyProviderConfig(cfg, ...args) {
      const resolved = params.resolveParams(cfg, ...args);
      return resolved ? params.applyPreset(cfg, resolved as TParams) : cfg;
    },
  };
}

export function withAgentModelAliases(
  existing: Record<string, AgentModelEntryConfig> | undefined,
  aliases: readonly AgentModelAliasEntry[],
): Record<string, AgentModelEntryConfig> {
  const next = { ...existing };
  for (const entry of aliases) {
    const normalized = normalizeAgentModelAliasEntry(entry);
    next[normalized.modelRef] = {
      ...next[normalized.modelRef],
      ...(normalized.alias ? { alias: next[normalized.modelRef]?.alias ?? normalized.alias } : {}),
    };
  }
  return next;
}

export function applyOnboardAuthAgentModelsAndProviders(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providers: Record<string, ModelProviderConfig>;
  },
): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models: params.agentModels,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers: params.providers,
    },
  };
}

export function applyAgentDefaultModelPrimary(
  cfg: OpenClawConfig,
  primary: string,
): OpenClawConfig {
  const existingFallbacks = extractAgentDefaultModelFallbacks(cfg.agents?.defaults?.model);
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(existingFallbacks ? { fallbacks: existingFallbacks } : undefined),
          primary,
        },
      },
    },
  };
}

export function applyOpencodeZenModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const current = resolvePrimaryStringValue(cfg.agents?.defaults?.model);
  const normalizedCurrent =
    current && LEGACY_OPENCODE_ZEN_DEFAULT_MODELS.has(current)
      ? OPENCODE_ZEN_DEFAULT_MODEL
      : current;
  if (normalizedCurrent === OPENCODE_ZEN_DEFAULT_MODEL) {
    return { changed: false, next: cfg };
  }
  return {
    changed: true,
    next: applyAgentDefaultModelPrimary(cfg, OPENCODE_ZEN_DEFAULT_MODEL),
  };
}

export function applyProviderConfigWithDefaultModels(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModels: ModelDefinitionConfig[];
    defaultModelId?: string;
  },
): OpenClawConfig {
  const providerState = resolveProviderModelMergeState(cfg, params.providerId);
  const { defaultModels } = params;
  const defaultModelId = params.defaultModelId ?? defaultModels[0]?.id;
  const hasDefaultModel = defaultModelId
    ? providerState.existingModels.some((model) => model.id === defaultModelId)
    : true;
  const mergedModels =
    providerState.existingModels.length > 0
      ? hasDefaultModel || defaultModels.length === 0
        ? providerState.existingModels
        : [...providerState.existingModels, ...defaultModels]
      : defaultModels;
  return applyProviderConfigWithMergedModels(cfg, {
    agentModels: params.agentModels,
    api: params.api,
    baseUrl: params.baseUrl,
    fallbackModels: defaultModels,
    mergedModels,
    providerId: params.providerId,
    providerState,
  });
}

export function applyProviderConfigWithDefaultModel(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModel: ModelDefinitionConfig;
    defaultModelId?: string;
  },
): OpenClawConfig {
  return applyProviderConfigWithDefaultModels(cfg, {
    agentModels: params.agentModels,
    api: params.api,
    baseUrl: params.baseUrl,
    defaultModelId: params.defaultModelId ?? params.defaultModel.id,
    defaultModels: [params.defaultModel],
    providerId: params.providerId,
  });
}

export function applyProviderConfigWithDefaultModelPreset(
  cfg: OpenClawConfig,
  params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModel: ModelDefinitionConfig;
    defaultModelId?: string;
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
  },
): OpenClawConfig {
  const next = applyProviderConfigWithDefaultModel(cfg, {
    agentModels: withAgentModelAliases(cfg.agents?.defaults?.models, params.aliases ?? []),
    api: params.api,
    baseUrl: params.baseUrl,
    defaultModel: params.defaultModel,
    defaultModelId: params.defaultModelId,
    providerId: params.providerId,
  });
  return params.primaryModelRef
    ? applyAgentDefaultModelPrimary(next, params.primaryModelRef)
    : next;
}

export function createDefaultModelPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (
    cfg: OpenClawConfig,
    ...args: TArgs
  ) =>
    | Omit<Parameters<typeof applyProviderConfigWithDefaultModelPreset>[1], "primaryModelRef">
    | null
    | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs> {
  return createProviderPresetAppliers({
    applyPreset: applyProviderConfigWithDefaultModelPreset,
    primaryModelRef: params.primaryModelRef,
    resolveParams: params.resolveParams,
  });
}

export function applyProviderConfigWithDefaultModelsPreset(
  cfg: OpenClawConfig,
  params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModels: ModelDefinitionConfig[];
    defaultModelId?: string;
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
  },
): OpenClawConfig {
  const next = applyProviderConfigWithDefaultModels(cfg, {
    agentModels: withAgentModelAliases(cfg.agents?.defaults?.models, params.aliases ?? []),
    api: params.api,
    baseUrl: params.baseUrl,
    defaultModelId: params.defaultModelId,
    defaultModels: params.defaultModels,
    providerId: params.providerId,
  });
  return params.primaryModelRef
    ? applyAgentDefaultModelPrimary(next, params.primaryModelRef)
    : next;
}

export function createDefaultModelsPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (
    cfg: OpenClawConfig,
    ...args: TArgs
  ) =>
    | Omit<Parameters<typeof applyProviderConfigWithDefaultModelsPreset>[1], "primaryModelRef">
    | null
    | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs> {
  return createProviderPresetAppliers({
    applyPreset: applyProviderConfigWithDefaultModelsPreset,
    primaryModelRef: params.primaryModelRef,
    resolveParams: params.resolveParams,
  });
}

export function applyProviderConfigWithModelCatalog(
  cfg: OpenClawConfig,
  params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    catalogModels: ModelDefinitionConfig[];
  },
): OpenClawConfig {
  const providerState = resolveProviderModelMergeState(cfg, params.providerId);
  const { catalogModels } = params;
  const mergedModels =
    providerState.existingModels.length > 0
      ? [
          ...providerState.existingModels,
          ...catalogModels.filter(
            (model) => !providerState.existingModels.some((existing) => existing.id === model.id),
          ),
        ]
      : catalogModels;
  return applyProviderConfigWithMergedModels(cfg, {
    agentModels: params.agentModels,
    api: params.api,
    baseUrl: params.baseUrl,
    fallbackModels: catalogModels,
    mergedModels,
    providerId: params.providerId,
    providerState,
  });
}

export function applyProviderConfigWithModelCatalogPreset(
  cfg: OpenClawConfig,
  params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    catalogModels: ModelDefinitionConfig[];
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
  },
): OpenClawConfig {
  const next = applyProviderConfigWithModelCatalog(cfg, {
    agentModels: withAgentModelAliases(cfg.agents?.defaults?.models, params.aliases ?? []),
    api: params.api,
    baseUrl: params.baseUrl,
    catalogModels: params.catalogModels,
    providerId: params.providerId,
  });
  return params.primaryModelRef
    ? applyAgentDefaultModelPrimary(next, params.primaryModelRef)
    : next;
}

export function createModelCatalogPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (
    cfg: OpenClawConfig,
    ...args: TArgs
  ) =>
    | Omit<Parameters<typeof applyProviderConfigWithModelCatalogPreset>[1], "primaryModelRef">
    | null
    | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs> {
  return createProviderPresetAppliers({
    applyPreset: applyProviderConfigWithModelCatalogPreset,
    primaryModelRef: params.primaryModelRef,
    resolveParams: params.resolveParams,
  });
}

export function ensureModelAllowlistEntry(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  defaultProvider?: string;
}): OpenClawConfig {
  const rawModelRef = params.modelRef.trim();
  if (!rawModelRef) {
    return params.cfg;
  }

  const models = { ...params.cfg.agents?.defaults?.models };
  const keySet = new Set<string>([rawModelRef]);
  const canonicalKey = resolveStaticAllowlistModelKey(
    rawModelRef,
    params.defaultProvider ?? DEFAULT_PROVIDER,
  );
  if (canonicalKey) {
    keySet.add(canonicalKey);
  }

  for (const key of keySet) {
    models[key] = {
      ...models[key],
    };
  }

  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults: {
        ...params.cfg.agents?.defaults,
        models,
      },
    },
  };
}
