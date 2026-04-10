import type { OpenClawConfig } from '../config/config.js';
import { resolveSecretInputRef } from '../config/types.secrets.js';
import {
  resolveManifestContractPluginIds,
  resolveManifestContractPluginIdsByCompatibilityRuntimePath,
} from '../plugins/manifest-registry.js';
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchCredentialResolutionSource,
  WebSearchCredentialResolutionSource,
} from '../plugins/types.js';
import { sortWebFetchProvidersForAutoDetect } from '../plugins/web-fetch-providers.shared.js';
import {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from '../plugins/web-provider-public-artifacts.explicit.js';
import { sortWebSearchProvidersForAutoDetect } from '../plugins/web-search-providers.shared.js';
import { createLazyRuntimeSurface } from '../shared/lazy-runtime.js';
import { normalizeLowercaseStringOrEmpty } from '../shared/string-coerce.js';
import { normalizeSecretInput } from '../utils/normalize-secret-input.js';
import { secretRefKey } from './ref-contract.js';
import { resolveSecretRefValues } from './resolve.js';
import type { ResolverContext, SecretDefaults } from './runtime-shared.js';
import {
  type SecretResolutionResult,
  ensureObject,
  hasConfiguredSecretRef,
  isRecord,
  resolveRuntimeWebProviderSelection,
  resolveRuntimeWebProviderSurface,
} from './runtime-web-tools.shared.js';
import type {
  RuntimeWebDiagnostic,
  RuntimeWebDiagnosticCode,
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
  RuntimeWebToolsMetadata,
} from './runtime-web-tools.types.js';

export type {
  RuntimeWebDiagnostic,
  RuntimeWebDiagnosticCode,
  RuntimeWebFetchMetadata,
  RuntimeWebSearchMetadata,
  RuntimeWebToolsMetadata,
};

const loadRuntimeWebToolsFallbackProviders = createLazyRuntimeSurface(
  () => import('./runtime-web-tools-fallback.runtime.js'),
  ({ runtimeWebToolsFallbackProviders }) => runtimeWebToolsFallbackProviders,
);
const loadRuntimeWebToolsPublicArtifacts = createLazyRuntimeSurface(
  () => import('./runtime-web-tools-public-artifacts.runtime.js'),
  (mod) => mod,
);

type FetchConfig = NonNullable<OpenClawConfig['tools']>['web'] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type SecretResolutionSource =
  | WebSearchCredentialResolutionSource
  | WebFetchCredentialResolutionSource;

function hasPluginScopedWebToolConfig(
  config: OpenClawConfig,
  key: 'webSearch' | 'webFetch',
): boolean {
  const entries = config.plugins?.entries;
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
    return Boolean(pluginConfig?.[key]);
  });
}

function inferSingleBundledPluginScopedWebToolConfigOwner(
  config: OpenClawConfig,
  key: 'webSearch' | 'webFetch',
): string | undefined {
  const entries = config.plugins?.entries;
  if (!entries) {
    return undefined;
  }
  const matches: string[] = [];
  for (const [pluginId, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || entry.enabled === false) {
      continue;
    }
    const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
    if (!isRecord(pluginConfig?.[key])) {
      continue;
    }
    matches.push(pluginId);
    if (matches.length > 1) {
      return undefined;
    }
  }
  return matches[0];
}

function inferExactBundledPluginScopedWebToolConfigOwner(params: {
  config: OpenClawConfig;
  key: 'webSearch' | 'webFetch';
  pluginId: string;
}): string | undefined {
  const entry = params.config.plugins?.entries?.[params.pluginId];
  if (!isRecord(entry) || entry.enabled === false) {
    return undefined;
  }
  const pluginConfig = isRecord(entry.config) ? entry.config : undefined;
  return isRecord(pluginConfig?.[params.key]) ? params.pluginId : undefined;
}

function hasCustomWebSearchPluginRisk(config: OpenClawConfig): boolean {
  const { plugins } = config;
  if (!plugins) {
    return false;
  }
  if (Array.isArray(plugins.load?.paths) && plugins.load.paths.length > 0) {
    return true;
  }
  if (plugins.installs && Object.keys(plugins.installs).length > 0) {
    return true;
  }

  const bundledPluginIds = new Set<string>(
    resolveManifestContractPluginIds({
      config,
      contract: 'webSearchProviders',
      env: process.env,
      origin: 'bundled',
    }),
  );
  const hasNonBundledPluginId = (pluginId: string) =>
    !bundledPluginIds.has(pluginId.trim());
  if (
    Array.isArray(plugins.allow) &&
    plugins.allow.some(hasNonBundledPluginId)
  ) {
    return true;
  }
  if (Array.isArray(plugins.deny) && plugins.deny.some(hasNonBundledPluginId)) {
    return true;
  }
  if (
    plugins.entries &&
    Object.keys(plugins.entries).some(hasNonBundledPluginId)
  ) {
    return true;
  }

  return false;
}

function readNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  names: string[],
): { value?: string; envVar?: string } {
  for (const envVar of names) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return { envVar, value };
    }
  }
  return {};
}

function buildUnresolvedReason(params: {
  path: string;
  kind: 'unresolved' | 'non-string' | 'empty';
  refLabel: string;
}): string {
  if (params.kind === 'non-string') {
    return `${params.path} SecretRef resolved to a non-string value.`;
  }
  if (params.kind === 'empty') {
    return `${params.path} SecretRef resolved to an empty value.`;
  }
  return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
}

async function resolveSecretInputWithEnvFallback(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  defaults: SecretDefaults | undefined;
  value: unknown;
  path: string;
  envVars: string[];
  restrictEnvRefsToEnvVars?: boolean;
}): Promise<SecretResolutionResult<SecretResolutionSource>> {
  const { ref } = resolveSecretInputRef({
    defaults: params.defaults,
    value: params.value,
  });

  if (!ref) {
    const configValue = normalizeSecretInput(params.value);
    if (configValue) {
      return {
        fallbackUsedAfterRefFailure: false,
        secretRefConfigured: false,
        source: 'config',
        value: configValue,
      };
    }
    const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
    if (fallback.value) {
      return {
        fallbackEnvVar: fallback.envVar,
        fallbackUsedAfterRefFailure: false,
        secretRefConfigured: false,
        source: 'env',
        value: fallback.value,
      };
    }
    return {
      fallbackUsedAfterRefFailure: false,
      secretRefConfigured: false,
      source: 'missing',
    };
  }

  const refLabel = `${ref.source}:${ref.provider}:${ref.id}`;
  let resolvedFromRef: string | undefined;
  let unresolvedRefReason: string | undefined;

  if (
    params.restrictEnvRefsToEnvVars === true &&
    ref.source === 'env' &&
    !params.envVars.includes(ref.id)
  ) {
    unresolvedRefReason = `${params.path} SecretRef env var "${ref.id}" is not allowed.`;
  } else {
    try {
      const resolved = await resolveSecretRefValues([ref], {
        cache: params.context.cache,
        config: params.sourceConfig,
        env: params.context.env,
      });
      const resolvedValue = resolved.get(secretRefKey(ref));
      if (typeof resolvedValue !== 'string') {
        unresolvedRefReason = buildUnresolvedReason({
          kind: 'non-string',
          path: params.path,
          refLabel,
        });
      } else {
        resolvedFromRef = normalizeSecretInput(resolvedValue);
        if (!resolvedFromRef) {
          unresolvedRefReason = buildUnresolvedReason({
            kind: 'empty',
            path: params.path,
            refLabel,
          });
        }
      }
    } catch {
      unresolvedRefReason = buildUnresolvedReason({
        kind: 'unresolved',
        path: params.path,
        refLabel,
      });
    }
  }

  if (resolvedFromRef) {
    return {
      fallbackUsedAfterRefFailure: false,
      secretRefConfigured: true,
      source: 'secretRef',
      value: resolvedFromRef,
    };
  }

  const fallback = readNonEmptyEnvValue(params.context.env, params.envVars);
  if (fallback.value) {
    return {
      fallbackEnvVar: fallback.envVar,
      fallbackUsedAfterRefFailure: true,
      secretRefConfigured: true,
      source: 'env',
      unresolvedRefReason,
      value: fallback.value,
    };
  }

  return {
    fallbackUsedAfterRefFailure: false,
    secretRefConfigured: true,
    source: 'missing',
    unresolvedRefReason,
  };
}

function setResolvedWebSearchApiKey(params: {
  resolvedConfig: OpenClawConfig;
  provider: PluginWebSearchProviderEntry;
  value: string;
}): void {
  const tools = ensureObject(
    params.resolvedConfig as Record<string, unknown>,
    'tools',
  );
  const web = ensureObject(tools, 'web');
  const search = ensureObject(web, 'search');
  if (params.provider.setConfiguredCredentialValue) {
    params.provider.setConfiguredCredentialValue(
      params.resolvedConfig,
      params.value,
    );
    if (params.provider.id !== 'brave') {
      return;
    }
  }
  params.provider.setCredentialValue(search, params.value);
}

async function resolveBundledWebSearchProviders(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  configuredBundledPluginId?: string;
  onlyPluginIds?: readonly string[];
  hasCustomWebSearchPluginRisk: boolean;
}): Promise<PluginWebSearchProviderEntry[]> {
  const env = { ...process.env, ...params.context.env };
  const onlyPluginIds =
    params.configuredBundledPluginId !== undefined
      ? [params.configuredBundledPluginId]
      : params.onlyPluginIds && params.onlyPluginIds.length > 0
        ? [...new Set(params.onlyPluginIds)].toSorted((left, right) =>
            left.localeCompare(right),
          )
        : undefined;
  if (onlyPluginIds && onlyPluginIds.length > 0) {
    const bundled = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts(
      { onlyPluginIds },
    );
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebSearchProviders } =
      await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebSearchProviders({
      bundledAllowlistCompat: true,
      config: params.sourceConfig,
      env,
      onlyPluginIds,
      origin: 'bundled',
    });
  }
  if (!params.hasCustomWebSearchPluginRisk) {
    const { resolveBundledWebSearchProvidersFromPublicArtifacts } =
      await loadRuntimeWebToolsPublicArtifacts();
    const bundled = resolveBundledWebSearchProvidersFromPublicArtifacts({
      bundledAllowlistCompat: true,
      config: params.sourceConfig,
      env,
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebSearchProviders } =
      await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebSearchProviders({
      bundledAllowlistCompat: true,
      config: params.sourceConfig,
      env,
      origin: 'bundled',
    });
  }
  const { resolvePluginWebSearchProviders } =
    await loadRuntimeWebToolsFallbackProviders();
  return resolvePluginWebSearchProviders({
    bundledAllowlistCompat: true,
    config: params.sourceConfig,
    env,
  });
}

async function resolveBundledWebFetchProviders(params: {
  sourceConfig: OpenClawConfig;
  context: ResolverContext;
  configuredBundledPluginId?: string;
}): Promise<PluginWebFetchProviderEntry[]> {
  const env = { ...process.env, ...params.context.env };
  if (params.configuredBundledPluginId) {
    const bundled = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({
      onlyPluginIds: [params.configuredBundledPluginId],
    });
    if (bundled && bundled.length > 0) {
      return bundled;
    }
    const { resolvePluginWebFetchProviders } =
      await loadRuntimeWebToolsFallbackProviders();
    return resolvePluginWebFetchProviders({
      bundledAllowlistCompat: true,
      config: params.sourceConfig,
      env,
      onlyPluginIds: [params.configuredBundledPluginId],
      origin: 'bundled',
    });
  }
  const { resolveBundledWebFetchProvidersFromPublicArtifacts } =
    await loadRuntimeWebToolsPublicArtifacts();
  const bundled = resolveBundledWebFetchProvidersFromPublicArtifacts({
    bundledAllowlistCompat: true,
    config: params.sourceConfig,
    env,
  });
  if (bundled && bundled.length > 0) {
    return bundled;
  }
  const { resolvePluginWebFetchProviders } =
    await loadRuntimeWebToolsFallbackProviders();
  return resolvePluginWebFetchProviders({
    bundledAllowlistCompat: true,
    config: params.sourceConfig,
    env,
    origin: 'bundled',
  });
}

function readConfiguredProviderCredential(params: {
  provider: PluginWebSearchProviderEntry;
  config: OpenClawConfig;
  search: Record<string, unknown> | undefined;
}): unknown {
  const configuredValue = params.provider.getConfiguredCredentialValue?.(
    params.config,
  );
  return configuredValue ?? params.provider.getCredentialValue(params.search);
}

function inactivePathsForProvider(
  provider: PluginWebSearchProviderEntry,
): string[] {
  if (provider.requiresCredential === false) {
    return [];
  }
  return provider.inactiveSecretPaths?.length
    ? provider.inactiveSecretPaths
    : [provider.credentialPath];
}

function setResolvedWebFetchApiKey(params: {
  resolvedConfig: OpenClawConfig;
  provider: PluginWebFetchProviderEntry;
  value: string;
}): void {
  const tools = ensureObject(
    params.resolvedConfig as Record<string, unknown>,
    'tools',
  );
  const web = ensureObject(tools, 'web');
  const fetch = ensureObject(web, 'fetch');
  if (params.provider.setConfiguredCredentialValue) {
    params.provider.setConfiguredCredentialValue(
      params.resolvedConfig,
      params.value,
    );
    return;
  }
  params.provider.setCredentialValue(fetch, params.value);
}

function readConfiguredFetchProviderCredential(params: {
  provider: PluginWebFetchProviderEntry;
  config: OpenClawConfig;
  fetch: Record<string, unknown> | undefined;
}): unknown {
  const configuredValue = params.provider.getConfiguredCredentialValue?.(
    params.config,
  );
  return configuredValue ?? params.provider.getCredentialValue(params.fetch);
}

function inactivePathsForFetchProvider(
  provider: PluginWebFetchProviderEntry,
): string[] {
  if (provider.requiresCredential === false) {
    return [];
  }
  return provider.inactiveSecretPaths?.length
    ? provider.inactiveSecretPaths
    : [provider.credentialPath];
}

export async function resolveRuntimeWebTools(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  context: ResolverContext;
}): Promise<RuntimeWebToolsMetadata> {
  const defaults = params.sourceConfig.secrets?.defaults;
  const diagnostics: RuntimeWebDiagnostic[] = [];

  const sourceTools = isRecord(params.sourceConfig.tools)
    ? params.sourceConfig.tools
    : undefined;
  const sourceWeb = isRecord(sourceTools?.web) ? sourceTools.web : undefined;
  const resolvedTools = isRecord(params.resolvedConfig.tools)
    ? params.resolvedConfig.tools
    : undefined;
  const resolvedWeb = isRecord(resolvedTools?.web)
    ? resolvedTools.web
    : undefined;
  let hasCustomWebSearchRisk: boolean | undefined;
  const getHasCustomWebSearchRisk = (): boolean => {
    hasCustomWebSearchRisk ??= hasCustomWebSearchPluginRisk(
      params.sourceConfig,
    );
    return hasCustomWebSearchRisk;
  };
  const legacyXSearchSource = isRecord(sourceWeb?.x_search)
    ? sourceWeb.x_search
    : undefined;
  const legacyXSearchResolved = isRecord(resolvedWeb?.x_search)
    ? resolvedWeb.x_search
    : undefined;

  // Doctor owns the migration, but runtime still needs to resolve the legacy SecretRef surface
  // So existing configs do not silently stop working before users repair them.
  if (
    legacyXSearchSource &&
    legacyXSearchResolved &&
    Object.hasOwn(legacyXSearchSource, 'apiKey')
  ) {
    const legacyXSearchSourceRecord = legacyXSearchSource as Record<
      string,
      unknown
    >;
    const legacyXSearchResolvedRecord = legacyXSearchResolved as Record<
      string,
      unknown
    >;
    const resolution = await resolveSecretInputWithEnvFallback({
      context: params.context,
      defaults,
      envVars: ['XAI_API_KEY'],
      path: 'tools.web.x_search.apiKey',
      sourceConfig: params.sourceConfig,
      value: legacyXSearchSourceRecord.apiKey,
    });
    if (resolution.value) {
      legacyXSearchResolvedRecord.apiKey = resolution.value;
    }
  }

  const hasPluginWebSearchConfig = hasPluginScopedWebToolConfig(
    params.sourceConfig,
    'webSearch',
  );
  const hasPluginWebFetchConfig = hasPluginScopedWebToolConfig(
    params.sourceConfig,
    'webFetch',
  );
  if (!sourceWeb && !hasPluginWebSearchConfig && !hasPluginWebFetchConfig) {
    return {
      diagnostics,
      fetch: {
        diagnostics: [],
        providerSource: 'none',
      },
      search: {
        diagnostics: [],
        providerSource: 'none',
      },
    };
  }
  const search = isRecord(sourceWeb?.search) ? sourceWeb.search : undefined;
  const fetch = isRecord(sourceWeb?.fetch)
    ? (sourceWeb.fetch as FetchConfig)
    : undefined;
  if (
    !search &&
    !fetch &&
    !hasPluginWebSearchConfig &&
    !hasPluginWebFetchConfig
  ) {
    return {
      diagnostics,
      fetch: {
        diagnostics: [],
        providerSource: 'none',
      },
      search: {
        diagnostics: [],
        providerSource: 'none',
      },
    };
  }
  const rawProvider = normalizeLowercaseStringOrEmpty(search?.provider);
  const configuredBundledWebSearchPluginIdHint =
    rawProvider && hasPluginWebSearchConfig
      ? (inferExactBundledPluginScopedWebToolConfigOwner({
          config: params.sourceConfig,
          key: 'webSearch',
          pluginId: rawProvider,
        }) ??
        (!getHasCustomWebSearchRisk()
          ? inferSingleBundledPluginScopedWebToolConfigOwner(
              params.sourceConfig,
              'webSearch',
            )
          : undefined))
      : undefined;
  const searchMetadata: RuntimeWebSearchMetadata = {
    diagnostics: [],
    providerSource: 'none',
  };
  if (search || hasPluginWebSearchConfig) {
    const searchCompatibilityOnlyPluginIds =
      !rawProvider &&
      !hasPluginWebSearchConfig &&
      isRecord(search) &&
      Object.hasOwn(search, 'apiKey')
        ? resolveManifestContractPluginIdsByCompatibilityRuntimePath({
            config: params.sourceConfig,
            contract: 'webSearchProviders',
            env: { ...process.env, ...params.context.env },
            origin: 'bundled',
            path: 'tools.web.search.apiKey',
          })
        : [];
    const searchSurface = await resolveRuntimeWebProviderSurface({
      configuredBundledPluginIdHint: configuredBundledWebSearchPluginIdHint,
      context: params.context,
      contract: 'webSearchProviders',
      diagnostics,
      emptyProvidersWhenSurfaceMissing: true,
      ignoreKeylessProvidersForConfiguredSurface: true,
      invalidAutoDetectCode: 'WEB_SEARCH_PROVIDER_INVALID_AUTODETECT',
      metadataDiagnostics: searchMetadata.diagnostics,
      normalizeConfiguredProviderAgainstActiveProviders: true,
      providerPath: 'tools.web.search.provider',
      rawProvider,
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredProviderCredential({
          config,
          provider,
          search: toolConfig,
        }),
      resolveProviders: ({ configuredBundledPluginId }) =>
        resolveBundledWebSearchProviders({
          configuredBundledPluginId,
          context: params.context,
          hasCustomWebSearchPluginRisk: getHasCustomWebSearchRisk(),
          onlyPluginIds:
            configuredBundledPluginId === undefined &&
            searchCompatibilityOnlyPluginIds.length > 0 &&
            !getHasCustomWebSearchRisk()
              ? searchCompatibilityOnlyPluginIds
              : undefined,
          sourceConfig: params.sourceConfig,
        }),
      sortProviders: sortWebSearchProvidersForAutoDetect,
      sourceConfig: params.sourceConfig,
      toolConfig: search,
    });

    await resolveRuntimeWebProviderSelection({
      autoDetectSelectedCode: 'WEB_SEARCH_AUTODETECT_SELECTED',
      configuredProvider: searchSurface.configuredProvider,
      context: params.context,
      defaults,
      deferKeylessFallback: true,
      diagnostics,
      enabled: searchSurface.enabled,
      fallbackUsedCode: 'WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED',
      hasConfiguredSecretRef,
      inactivePathsForProvider,
      mergeRuntimeMetadata: async ({
        provider,
        metadata,
        toolConfig,
        selectedResolution,
      }) => {
        if (!provider.resolveRuntimeMetadata) {
          return;
        }
        Object.assign(
          metadata,
          await provider.resolveRuntimeMetadata({
            config: params.sourceConfig,
            resolvedCredential: selectedResolution
              ? {
                  value: selectedResolution.value,
                  source: selectedResolution.source as any,
                  fallbackEnvVar: selectedResolution.fallbackEnvVar,
                }
              : undefined,
            runtimeMetadata: metadata,
            searchConfig: toolConfig,
          }),
        );
      },
      metadata: searchMetadata,
      noFallbackCode: 'WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK',
      providers: searchSurface.providers,
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredProviderCredential({
          config,
          provider,
          search: toolConfig,
        }),
      resolveSecretInput: ({ value, path, envVars }) =>
        resolveSecretInputWithEnvFallback({
          context: params.context,
          defaults,
          envVars,
          path,
          sourceConfig: params.sourceConfig,
          value,
        }),
      resolvedConfig: params.resolvedConfig,
      scopePath: 'tools.web.search',
      setResolvedCredential: ({ resolvedConfig, provider, value }) =>
        setResolvedWebSearchApiKey({
          provider,
          resolvedConfig,
          value,
        }),
      sourceConfig: params.sourceConfig,
      toolConfig: search,
    });
  }

  const rawFetchProvider = normalizeLowercaseStringOrEmpty(fetch?.provider);
  const fetchMetadata: RuntimeWebFetchMetadata = {
    diagnostics: [],
    providerSource: 'none',
  };
  if (fetch || hasPluginWebFetchConfig) {
    const fetchSurface = await resolveRuntimeWebProviderSurface({
      context: params.context,
      contract: 'webFetchProviders',
      diagnostics,
      invalidAutoDetectCode: 'WEB_FETCH_PROVIDER_INVALID_AUTODETECT',
      metadataDiagnostics: fetchMetadata.diagnostics,
      providerPath: 'tools.web.fetch.provider',
      rawProvider: rawFetchProvider,
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredFetchProviderCredential({
          config,
          fetch: toolConfig,
          provider,
        }),
      resolveProviders: ({ configuredBundledPluginId }) =>
        resolveBundledWebFetchProviders({
          configuredBundledPluginId,
          context: params.context,
          sourceConfig: params.sourceConfig,
        }),
      sortProviders: sortWebFetchProvidersForAutoDetect,
      sourceConfig: params.sourceConfig,
      toolConfig: fetch,
    });

    await resolveRuntimeWebProviderSelection({
      autoDetectSelectedCode: 'WEB_FETCH_AUTODETECT_SELECTED',
      configuredProvider: fetchSurface.configuredProvider,
      context: params.context,
      defaults,
      deferKeylessFallback: false,
      diagnostics,
      enabled: fetchSurface.enabled,
      fallbackUsedCode: 'WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED',
      hasConfiguredSecretRef,
      inactivePathsForProvider: inactivePathsForFetchProvider,
      mergeRuntimeMetadata: async ({
        provider,
        metadata,
        toolConfig,
        selectedResolution,
      }) => {
        if (!provider.resolveRuntimeMetadata) {
          return;
        }
        Object.assign(
          metadata,
          await provider.resolveRuntimeMetadata({
            config: params.sourceConfig,
            fetchConfig: toolConfig,
            resolvedCredential: selectedResolution
              ? {
                  value: selectedResolution.value,
                  source: selectedResolution.source,
                  fallbackEnvVar: selectedResolution.fallbackEnvVar,
                }
              : undefined,
            runtimeMetadata: metadata,
          }),
        );
      },
      metadata: fetchMetadata,
      noFallbackCode: 'WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK',
      providers: fetchSurface.providers,
      readConfiguredCredential: ({ provider, config, toolConfig }) =>
        readConfiguredFetchProviderCredential({
          config,
          fetch: toolConfig,
          provider,
        }),
      resolveSecretInput: ({ value, path, envVars }) =>
        resolveSecretInputWithEnvFallback({
          context: params.context,
          defaults,
          envVars,
          path,
          restrictEnvRefsToEnvVars: true,
          sourceConfig: params.sourceConfig,
          value,
        }),
      resolvedConfig: params.resolvedConfig,
      scopePath: 'tools.web.fetch',
      setResolvedCredential: ({ resolvedConfig, provider, value }) =>
        setResolvedWebFetchApiKey({
          provider,
          resolvedConfig,
          value,
        }),
      sourceConfig: params.sourceConfig,
      toolConfig: fetch,
    });
  }

  return {
    diagnostics,
    fetch: fetchMetadata,
    search: searchMetadata,
  };
}
