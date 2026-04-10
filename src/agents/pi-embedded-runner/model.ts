import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  clearProviderRuntimeHookCache,
  normalizeProviderResolvedModelWithPlugin,
  normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel,
} from "../../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/types.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import {
  buildSuppressedBuiltInModelError,
  shouldSuppressBuiltInModel,
} from "../model-suppression.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import {
  attachModelProviderRequestTransport,
  resolveProviderRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-request-config.js";
import {
  type InlineProviderConfig,
  buildInlineProviderModels,
  normalizeResolvedTransportApi,
  resolveProviderModelInput,
  sanitizeModelHeaders,
} from "./model.inline-provider.js";
import { normalizeResolvedProviderModel } from "./model.provider-normalization.js";

interface ProviderRuntimeHooks {
  applyProviderResolvedModelCompatWithPlugins?: (
    params: Parameters<typeof applyProviderResolvedModelCompatWithPlugins>[0],
  ) => unknown;
  applyProviderResolvedTransportWithPlugin?: (
    params: Parameters<typeof applyProviderResolvedTransportWithPlugin>[0],
  ) => unknown;
  buildProviderUnknownModelHintWithPlugin: (
    params: Parameters<typeof buildProviderUnknownModelHintWithPlugin>[0],
  ) => string | undefined;
  clearProviderRuntimeHookCache: () => void;
  prepareProviderDynamicModel: (
    params: Parameters<typeof prepareProviderDynamicModel>[0],
  ) => Promise<void>;
  runProviderDynamicModel: (params: Parameters<typeof runProviderDynamicModel>[0]) => unknown;
  shouldPreferProviderRuntimeResolvedModel?: (
    params: Parameters<typeof shouldPreferProviderRuntimeResolvedModel>[0],
  ) => boolean;
  normalizeProviderResolvedModelWithPlugin: (
    params: Parameters<typeof normalizeProviderResolvedModelWithPlugin>[0],
  ) => unknown;
  normalizeProviderTransportWithPlugin: (
    params: Parameters<typeof normalizeProviderTransportWithPlugin>[0],
  ) => unknown;
}

const DEFAULT_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin,
  clearProviderRuntimeHookCache,
  normalizeProviderResolvedModelWithPlugin,
  normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel,
  runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel,
};

const STATIC_PROVIDER_RUNTIME_HOOKS: ProviderRuntimeHooks = {
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  clearProviderRuntimeHookCache: () => {},
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
};

function resolveRuntimeHooks(params?: {
  runtimeHooks?: ProviderRuntimeHooks;
  skipProviderRuntimeHooks?: boolean;
}): ProviderRuntimeHooks {
  if (params?.skipProviderRuntimeHooks) {
    return STATIC_PROVIDER_RUNTIME_HOOKS;
  }
  return params?.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
}

function applyResolvedTransportFallback(params: {
  provider: string;
  cfg?: OpenClawConfig;
  runtimeHooks: ProviderRuntimeHooks;
  model: Model<Api>;
}): Model<Api> | undefined {
  const normalized = params.runtimeHooks.normalizeProviderTransportWithPlugin({
    config: params.cfg,
    context: {
      api: params.model.api,
      baseUrl: params.model.baseUrl,
      provider: params.provider,
    },
    provider: params.provider,
  }) as { api?: Api | null; baseUrl?: string } | undefined;
  if (!normalized) {
    return undefined;
  }
  const nextApi = normalizeResolvedTransportApi(normalized.api) ?? params.model.api;
  const nextBaseUrl = normalized.baseUrl ?? params.model.baseUrl;
  if (nextApi === params.model.api && nextBaseUrl === params.model.baseUrl) {
    return undefined;
  }
  return {
    ...params.model,
    api: nextApi,
    baseUrl: nextBaseUrl,
  };
}

function normalizeResolvedModel(params: {
  provider: string;
  model: Model<Api>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> {
  const normalizedInputModel = {
    ...params.model,
    input: resolveProviderModelInput({
      input: params.model.input,
      modelId: params.model.id,
      modelName: params.model.name,
      provider: params.provider,
    }),
  } as Model<Api>;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const pluginNormalized = runtimeHooks.normalizeProviderResolvedModelWithPlugin({
    config: params.cfg,
    context: {
      agentDir: params.agentDir,
      config: params.cfg,
      model: normalizedInputModel,
      modelId: normalizedInputModel.id,
      provider: params.provider,
    },
    provider: params.provider,
  }) as Model<Api> | undefined;
  const compatNormalized = runtimeHooks.applyProviderResolvedModelCompatWithPlugins?.({
    config: params.cfg,
    context: {
      agentDir: params.agentDir,
      config: params.cfg,
      model: (pluginNormalized ?? normalizedInputModel) as never,
      modelId: normalizedInputModel.id,
      provider: params.provider,
    },
    provider: params.provider,
  }) as Model<Api> | undefined;
  const transportNormalized = runtimeHooks.applyProviderResolvedTransportWithPlugin?.({
    config: params.cfg,
    context: {
      agentDir: params.agentDir,
      config: params.cfg,
      model: (compatNormalized ?? pluginNormalized ?? normalizedInputModel) as never,
      modelId: normalizedInputModel.id,
      provider: params.provider,
    },
    provider: params.provider,
  }) as Model<Api> | undefined;
  const fallbackTransportNormalized =
    transportNormalized ??
    applyResolvedTransportFallback({
      cfg: params.cfg,
      model: compatNormalized ?? pluginNormalized ?? normalizedInputModel,
      provider: params.provider,
      runtimeHooks,
    });
  return normalizeResolvedProviderModel({
    model:
      fallbackTransportNormalized ?? compatNormalized ?? pluginNormalized ?? normalizedInputModel,
    provider: params.provider,
  });
}

function resolveProviderTransport(params: {
  provider: string;
  api?: Api | null;
  baseUrl?: string;
  cfg?: OpenClawConfig;
  runtimeHooks?: ProviderRuntimeHooks;
}): {
  api?: Api;
  baseUrl?: string;
} {
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const normalized = runtimeHooks.normalizeProviderTransportWithPlugin({
    config: params.cfg,
    context: {
      api: params.api,
      baseUrl: params.baseUrl,
      provider: params.provider,
    },
    provider: params.provider,
  }) as { api?: Api | null; baseUrl?: string } | undefined;

  return {
    api: normalizeResolvedTransportApi(normalized?.api ?? params.api),
    baseUrl: normalized?.baseUrl ?? params.baseUrl,
  };
}

function findInlineModelMatch(params: {
  providers: Record<string, InlineProviderConfig>;
  provider: string;
  modelId: string;
}) {
  const inlineModels = buildInlineProviderModels(params.providers);
  const exact = inlineModels.find(
    (entry) => entry.provider === params.provider && entry.id === params.modelId,
  );
  if (exact) {
    return exact;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  return inlineModels.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider && entry.id === params.modelId,
  );
}

export { buildModelAliasLines, buildInlineProviderModels };

function resolveConfiguredProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): InlineProviderConfig | undefined {
  const configuredProviders = cfg?.models?.providers;
  if (!configuredProviders) {
    return undefined;
  }
  const exactProviderConfig = configuredProviders[provider];
  if (exactProviderConfig) {
    return exactProviderConfig;
  }
  return findNormalizedProviderValue(configuredProviders, provider);
}

function applyConfiguredProviderOverrides(params: {
  provider: string;
  discoveredModel: ProviderRuntimeModel;
  providerConfig?: InlineProviderConfig;
  modelId: string;
  cfg?: OpenClawConfig;
  runtimeHooks?: ProviderRuntimeHooks;
}): ProviderRuntimeModel {
  const { discoveredModel, providerConfig, modelId } = params;
  if (!providerConfig) {
    return {
      ...discoveredModel,
      // Discovered models originate from models.json and may contain persistence markers.
      headers: sanitizeModelHeaders(discoveredModel.headers, { stripSecretRefMarkers: true }),
    };
  }
  const configuredModel = providerConfig.models?.find((candidate) => candidate.id === modelId);
  const discoveredHeaders = sanitizeModelHeaders(discoveredModel.headers, {
    stripSecretRefMarkers: true,
  });
  const providerHeaders = sanitizeModelHeaders(providerConfig.headers, {
    stripSecretRefMarkers: true,
  });
  const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig.request);
  const configuredHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  if (
    !configuredModel &&
    !providerConfig.baseUrl &&
    !providerConfig.api &&
    !providerHeaders &&
    !providerRequest
  ) {
    return {
      ...discoveredModel,
      headers: discoveredHeaders,
    };
  }
  const normalizedInput = resolveProviderModelInput({
    fallbackInput: discoveredModel.input,
    input: configuredModel?.input,
    modelId,
    modelName: configuredModel?.name ?? discoveredModel.name,
    provider: params.provider,
  });

  const resolvedTransport = resolveProviderTransport({
    api: configuredModel?.api ?? providerConfig.api ?? discoveredModel.api,
    baseUrl: providerConfig.baseUrl ?? discoveredModel.baseUrl,
    cfg: params.cfg,
    provider: params.provider,
    runtimeHooks: params.runtimeHooks,
  });
  const requestConfig = resolveProviderRequestConfig({
    api:
      resolvedTransport.api ??
      normalizeResolvedTransportApi(discoveredModel.api) ??
      "openai-responses",
    authHeader: providerConfig.authHeader,
    baseUrl: resolvedTransport.baseUrl ?? discoveredModel.baseUrl,
    capability: "llm",
    discoveredHeaders,
    modelHeaders: configuredHeaders,
    provider: params.provider,
    providerHeaders,
    request: providerRequest,
    transport: "stream",
  });
  return attachModelProviderRequestTransport(
    {
      ...discoveredModel,
      api: requestConfig.api ?? "openai-responses",
      baseUrl: requestConfig.baseUrl ?? discoveredModel.baseUrl,
      compat: configuredModel?.compat ?? discoveredModel.compat,
      contextTokens: configuredModel?.contextTokens ?? discoveredModel.contextTokens,
      contextWindow: configuredModel?.contextWindow ?? discoveredModel.contextWindow,
      cost: configuredModel?.cost ?? discoveredModel.cost,
      headers: requestConfig.headers,
      input: normalizedInput,
      maxTokens: configuredModel?.maxTokens ?? discoveredModel.maxTokens,
      reasoning: configuredModel?.reasoning ?? discoveredModel.reasoning,
    },
    providerRequest,
  );
}
function resolveExplicitModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): { kind: "resolved"; model: Model<Api> } | { kind: "suppressed" } | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, runtimeHooks } = params;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  if (
    shouldSuppressBuiltInModel({
      baseUrl: providerConfig?.baseUrl,
      config: cfg,
      id: modelId,
      provider,
    })
  ) {
    return { kind: "suppressed" };
  }
  const inlineMatch = findInlineModelMatch({
    modelId,
    provider,
    providers: cfg?.models?.providers ?? {},
  });
  if (inlineMatch?.api) {
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        agentDir,
        cfg,
        model: inlineMatch as Model<Api>,
        provider,
        runtimeHooks,
      }),
    };
  }
  const model = modelRegistry.find(provider, modelId) as Model<Api> | null;

  if (model) {
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        agentDir,
        cfg,
        model: applyConfiguredProviderOverrides({
          cfg,
          discoveredModel: model,
          modelId,
          provider,
          providerConfig,
          runtimeHooks,
        }),
        provider,
        runtimeHooks,
      }),
    };
  }

  const providers = cfg?.models?.providers ?? {};
  const fallbackInlineMatch = findInlineModelMatch({
    modelId,
    provider,
    providers,
  });
  if (fallbackInlineMatch?.api) {
    return {
      kind: "resolved",
      model: normalizeResolvedModel({
        agentDir,
        cfg,
        model: fallbackInlineMatch as Model<Api>,
        provider,
        runtimeHooks,
      }),
    };
  }

  return undefined;
}

function resolvePluginDynamicModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir } = params;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const pluginDynamicModel = runtimeHooks.runProviderDynamicModel({
    config: cfg,
    context: {
      agentDir,
      config: cfg,
      modelId,
      modelRegistry,
      provider,
      providerConfig,
    },
    provider,
    workspaceDir,
  }) as Model<Api> | undefined;
  if (!pluginDynamicModel) {
    return undefined;
  }
  const overriddenDynamicModel = applyConfiguredProviderOverrides({
    cfg,
    discoveredModel: pluginDynamicModel,
    modelId,
    provider,
    providerConfig,
    runtimeHooks,
  });
  return normalizeResolvedModel({
    agentDir,
    cfg,
    model: overriddenDynamicModel,
    provider,
    runtimeHooks,
  });
}

function resolveConfiguredFallbackModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined {
  const { provider, modelId, cfg, agentDir, runtimeHooks } = params;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const configuredModel = providerConfig?.models?.find((candidate) => candidate.id === modelId);
  const providerHeaders = sanitizeModelHeaders(providerConfig?.headers, {
    stripSecretRefMarkers: true,
  });
  const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig?.request);
  const modelHeaders = sanitizeModelHeaders(configuredModel?.headers, {
    stripSecretRefMarkers: true,
  });
  if (!providerConfig && !modelId.startsWith("mock-")) {
    return undefined;
  }
  const fallbackTransport = resolveProviderTransport({
    api: providerConfig?.api ?? "openai-responses",
    baseUrl: providerConfig?.baseUrl,
    cfg,
    provider,
    runtimeHooks,
  });
  const requestConfig = resolveProviderRequestConfig({
    api: fallbackTransport.api ?? "openai-responses",
    authHeader: providerConfig?.authHeader,
    baseUrl: fallbackTransport.baseUrl,
    capability: "llm",
    modelHeaders,
    provider,
    providerHeaders,
    request: providerRequest,
    transport: "stream",
  });
  return normalizeResolvedModel({
    agentDir,
    cfg,
    model: attachModelProviderRequestTransport(
      {
        api: requestConfig.api ?? "openai-responses",
        baseUrl: requestConfig.baseUrl,
        contextTokens: configuredModel?.contextTokens ?? providerConfig?.models?.[0]?.contextTokens,
        contextWindow:
          configuredModel?.contextWindow ??
          providerConfig?.models?.[0]?.contextWindow ??
          DEFAULT_CONTEXT_TOKENS,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        headers: requestConfig.headers,
        id: modelId,
        input: resolveProviderModelInput({
          provider,
          modelId,
          modelName: configuredModel?.name ?? modelId,
          input: configuredModel?.input,
        }),
        maxTokens:
          configuredModel?.maxTokens ??
          providerConfig?.models?.[0]?.maxTokens ??
          DEFAULT_CONTEXT_TOKENS,
        name: modelId,
        provider,
        reasoning: configuredModel?.reasoning ?? false,
      } as Model<Api>,
      providerRequest,
    ),
    provider,
    runtimeHooks,
  });
}

function shouldCompareProviderRuntimeResolvedModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks: ProviderRuntimeHooks;
}): boolean {
  return (
    params.runtimeHooks.shouldPreferProviderRuntimeResolvedModel?.({
      config: params.cfg,
      context: {
        agentDir: params.agentDir,
        config: params.cfg,
        modelId: params.modelId,
        provider: params.provider,
        workspaceDir: params.workspaceDir,
      },
      provider: params.provider,
      workspaceDir: params.workspaceDir,
    }) ?? false
  );
}

function preferProviderRuntimeResolvedModel(params: {
  explicitModel: Model<Api>;
  runtimeResolvedModel?: Model<Api>;
}): Model<Api> {
  if (
    params.runtimeResolvedModel &&
    params.runtimeResolvedModel.contextWindow > params.explicitModel.contextWindow
  ) {
    return params.runtimeResolvedModel;
  }
  return params.explicitModel;
}

export function resolveModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined {
  const normalizedRef = {
    model: normalizeStaticProviderModelId(normalizeProviderId(params.provider), params.modelId),
    provider: params.provider,
  };
  const normalizedParams = {
    ...params,
    modelId: normalizedRef.model,
    provider: normalizedRef.provider,
  };
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const workspaceDir = normalizedParams.cfg?.agents?.defaults?.workspace;
  const explicitModel = resolveExplicitModelWithRegistry(normalizedParams);
  if (explicitModel?.kind === "suppressed") {
    return undefined;
  }
  if (explicitModel?.kind === "resolved") {
    if (
      !shouldCompareProviderRuntimeResolvedModel({
        agentDir: normalizedParams.agentDir,
        cfg: normalizedParams.cfg,
        modelId: normalizedParams.modelId,
        provider: normalizedParams.provider,
        runtimeHooks,
        workspaceDir,
      })
    ) {
      return explicitModel.model;
    }
    const pluginDynamicModel = resolvePluginDynamicModelWithRegistry({
      ...normalizedParams,
      workspaceDir,
    });
    return preferProviderRuntimeResolvedModel({
      explicitModel: explicitModel.model,
      runtimeResolvedModel: pluginDynamicModel,
    });
  }
  const pluginDynamicModel = resolvePluginDynamicModelWithRegistry(normalizedParams);
  if (pluginDynamicModel) {
    return pluginDynamicModel;
  }

  return resolveConfiguredFallbackModel(normalizedParams);
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: {
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    runtimeHooks?: ProviderRuntimeHooks;
    skipProviderRuntimeHooks?: boolean;
  },
): {
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const normalizedRef = {
    model: normalizeStaticProviderModelId(normalizeProviderId(provider), modelId),
    provider,
  };
  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
  const authStorage = options?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = options?.modelRegistry ?? discoverModels(authStorage, resolvedAgentDir);
  const runtimeHooks = resolveRuntimeHooks(options);
  const model = resolveModelWithRegistry({
    agentDir: resolvedAgentDir,
    cfg,
    modelId: normalizedRef.model,
    modelRegistry,
    provider: normalizedRef.provider,
    runtimeHooks,
  });
  if (model) {
    return { authStorage, model, modelRegistry };
  }

  return {
    authStorage,
    error: buildUnknownModelError({
      agentDir: resolvedAgentDir,
      cfg,
      modelId: normalizedRef.model,
      provider: normalizedRef.provider,
      runtimeHooks,
    }),
    modelRegistry,
  };
}

export async function resolveModelAsync(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: {
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    retryTransientProviderRuntimeMiss?: boolean;
    runtimeHooks?: ProviderRuntimeHooks;
    skipProviderRuntimeHooks?: boolean;
  },
): Promise<{
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}> {
  const normalizedRef = {
    model: normalizeStaticProviderModelId(normalizeProviderId(provider), modelId),
    provider,
  };
  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
  const authStorage = options?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = options?.modelRegistry ?? discoverModels(authStorage, resolvedAgentDir);
  const runtimeHooks = resolveRuntimeHooks(options);
  const explicitModel = resolveExplicitModelWithRegistry({
    agentDir: resolvedAgentDir,
    cfg,
    modelId: normalizedRef.model,
    modelRegistry,
    provider: normalizedRef.provider,
    runtimeHooks,
  });
  if (explicitModel?.kind === "suppressed") {
    return {
      authStorage,
      error: buildUnknownModelError({
        agentDir: resolvedAgentDir,
        cfg,
        modelId: normalizedRef.model,
        provider: normalizedRef.provider,
        runtimeHooks,
      }),
      modelRegistry,
    };
  }
  const providerConfig = resolveConfiguredProviderConfig(cfg, normalizedRef.provider);
  const resolveDynamicAttempt = async (attemptOptions?: { clearHookCache?: boolean }) => {
    if (attemptOptions?.clearHookCache) {
      runtimeHooks.clearProviderRuntimeHookCache();
    }
    await runtimeHooks.prepareProviderDynamicModel({
      config: cfg,
      context: {
        agentDir: resolvedAgentDir,
        config: cfg,
        modelId: normalizedRef.model,
        modelRegistry,
        provider: normalizedRef.provider,
        providerConfig,
      },
      provider: normalizedRef.provider,
    });
    return resolveModelWithRegistry({
      agentDir: resolvedAgentDir,
      cfg,
      modelId: normalizedRef.model,
      modelRegistry,
      provider: normalizedRef.provider,
      runtimeHooks,
    });
  };
  let model =
    explicitModel?.kind === "resolved" &&
    !shouldCompareProviderRuntimeResolvedModel({
      agentDir: resolvedAgentDir,
      cfg,
      modelId: normalizedRef.model,
      provider: normalizedRef.provider,
      runtimeHooks,
    })
      ? explicitModel.model
      : await resolveDynamicAttempt();
  if (!model && !explicitModel && options?.retryTransientProviderRuntimeMiss) {
    // Startup can race the first provider-runtime snapshot load on a fresh
    // Gateway boot. Retry once with a cleared hook cache before surfacing a
    // User-visible "Unknown model" that disappears on the next message.
    model = await resolveDynamicAttempt({ clearHookCache: true });
  }
  if (model) {
    return { authStorage, model, modelRegistry };
  }

  return {
    authStorage,
    error: buildUnknownModelError({
      agentDir: resolvedAgentDir,
      cfg,
      modelId: normalizedRef.model,
      provider: normalizedRef.provider,
      runtimeHooks,
    }),
    modelRegistry,
  };
}

/**
 * Build a more helpful error when the model is not found.
 *
 * Some provider plugins only become available after setup/auth has registered
 * them. When users point `agents.defaults.model.primary` at one of those
 * providers before setup, the raw `Unknown model` error is too vague. Provider
 * plugins can append a targeted recovery hint here.
 *
 * See: https://github.com/openclaw/openclaw/issues/17328
 */
function buildUnknownModelError(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): string {
  const suppressed = buildSuppressedBuiltInModelError({
    id: params.modelId,
    provider: params.provider,
  });
  if (suppressed) {
    return suppressed;
  }
  const base = `Unknown model: ${params.provider}/${params.modelId}`;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const hint = runtimeHooks.buildProviderUnknownModelHintWithPlugin({
    config: params.cfg,
    context: {
      agentDir: params.agentDir,
      config: params.cfg,
      env: process.env,
      modelId: params.modelId,
      provider: params.provider,
    },
    env: process.env,
    provider: params.provider,
  });
  return hint ? `${base}. ${hint}` : base;
}
