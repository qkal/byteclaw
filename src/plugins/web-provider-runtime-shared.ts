import type { OpenClawConfig } from "../config/config.js";
import { withActivatedPluginIds } from "./activation-context.js";
import {
  buildPluginSnapshotCacheEnvKey,
  resolvePluginSnapshotCacheTtlMs,
  shouldUsePluginSnapshotCache,
} from "./cache-controls.js";
import {
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  resolveCompatibleRuntimePluginRegistry,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import { buildWebProviderSnapshotCacheKey } from "./web-provider-resolution-shared.js";

interface WebProviderSnapshotCacheEntry<TEntry> {
  expiresAt: number;
  providers: TEntry[];
}

export type WebProviderSnapshotCache<TEntry> = WeakMap<
  OpenClawConfig,
  WeakMap<NodeJS.ProcessEnv, Map<string, WebProviderSnapshotCacheEntry<TEntry>>>
>;

export interface ResolvePluginWebProvidersParams {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
}

interface ResolveWebProviderRuntimeDeps<TEntry> {
  snapshotCache: WebProviderSnapshotCache<TEntry>;
  resolveBundledResolutionConfig: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    bundledAllowlistCompat?: boolean;
  }) => {
    config: PluginLoadOptions["config"];
    activationSourceConfig?: PluginLoadOptions["config"];
    autoEnabledReasons: Record<string, string[]>;
  };
  resolveCandidatePluginIds: (params: {
    config?: PluginLoadOptions["config"];
    workspaceDir?: string;
    env?: PluginLoadOptions["env"];
    onlyPluginIds?: readonly string[];
    origin?: PluginManifestRecord["origin"];
  }) => string[] | undefined;
  mapRegistryProviders: (params: {
    registry: PluginRegistry;
    onlyPluginIds?: readonly string[];
  }) => TEntry[];
}

export function createWebProviderSnapshotCache<TEntry>(): WebProviderSnapshotCache<TEntry> {
  return new WeakMap<
    OpenClawConfig,
    WeakMap<NodeJS.ProcessEnv, Map<string, WebProviderSnapshotCacheEntry<TEntry>>>
  >();
}

function resolveWebProviderLoadOptions<TEntry>(
  params: ResolvePluginWebProvidersParams,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const { config, activationSourceConfig, autoEnabledReasons } =
    deps.resolveBundledResolutionConfig({
      ...params,
      env,
      workspaceDir,
    });
  const onlyPluginIds = deps.resolveCandidatePluginIds({
    config,
    env,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
    workspaceDir,
  });
  return buildPluginRuntimeLoadOptionsFromValues(
    {
      activationSourceConfig,
      autoEnabledReasons,
      config,
      env,
      logger: createPluginRuntimeLoaderLogger(),
      workspaceDir,
    },
    {
      activate: params.activate ?? false,
      cache: params.cache ?? false,
      ...(onlyPluginIds ? { onlyPluginIds } : {}),
    },
  );
}

export function resolvePluginWebProviders<TEntry>(
  params: ResolvePluginWebProvidersParams,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
): TEntry[] {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  if (params.mode === "setup") {
    const pluginIds =
      deps.resolveCandidatePluginIds({
        config: params.config,
        env,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
        workspaceDir,
      }) ?? [];
    if (pluginIds.length === 0) {
      return [];
    }
    const registry = loadOpenClawPlugins(
      buildPluginRuntimeLoadOptionsFromValues(
        {
          activationSourceConfig: params.config,
          autoEnabledReasons: {},
          config: withActivatedPluginIds({
            config: params.config,
            pluginIds,
          }),
          env,
          logger: createPluginRuntimeLoaderLogger(),
          workspaceDir,
        },
        {
          activate: params.activate ?? false,
          cache: params.cache ?? false,
          onlyPluginIds: pluginIds,
        },
      ),
    );
    return deps.mapRegistryProviders({ onlyPluginIds: pluginIds, registry });
  }

  const cacheOwnerConfig = params.config;
  const shouldMemoizeSnapshot =
    params.activate !== true && params.cache !== true && shouldUsePluginSnapshotCache(env);
  const cacheKey = buildWebProviderSnapshotCacheKey({
    bundledAllowlistCompat: params.bundledAllowlistCompat,
    config: cacheOwnerConfig,
    envKey: buildPluginSnapshotCacheEnvKey(env),
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
    workspaceDir,
  });
  if (cacheOwnerConfig && shouldMemoizeSnapshot) {
    const configCache = deps.snapshotCache.get(cacheOwnerConfig);
    const envCache = configCache?.get(env);
    const cached = envCache?.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.providers;
    }
  }
  const memoizeSnapshot = (providers: TEntry[]) => {
    if (!cacheOwnerConfig || !shouldMemoizeSnapshot) {
      return;
    }
    const ttlMs = resolvePluginSnapshotCacheTtlMs(env);
    let configCache = deps.snapshotCache.get(cacheOwnerConfig);
    if (!configCache) {
      configCache = new WeakMap<
        NodeJS.ProcessEnv,
        Map<string, WebProviderSnapshotCacheEntry<TEntry>>
      >();
      deps.snapshotCache.set(cacheOwnerConfig, configCache);
    }
    let envCache = configCache.get(env);
    if (!envCache) {
      envCache = new Map<string, WebProviderSnapshotCacheEntry<TEntry>>();
      configCache.set(env, envCache);
    }
    envCache.set(cacheKey, {
      expiresAt: Date.now() + ttlMs,
      providers,
    });
  };

  const loadOptions = resolveWebProviderLoadOptions(params, deps);
  const compatible = resolveCompatibleRuntimePluginRegistry(loadOptions);
  if (compatible) {
    const resolved = deps.mapRegistryProviders({
      onlyPluginIds: params.onlyPluginIds,
      registry: compatible,
    });
    memoizeSnapshot(resolved);
    return resolved;
  }
  if (isPluginRegistryLoadInFlight(loadOptions)) {
    return [];
  }
  const resolved = deps.mapRegistryProviders({
    onlyPluginIds: params.onlyPluginIds,
    registry: loadOpenClawPlugins(loadOptions),
  });
  memoizeSnapshot(resolved);
  return resolved;
}

export function resolveRuntimeWebProviders<TEntry>(
  params: Omit<ResolvePluginWebProvidersParams, "activate" | "cache" | "mode">,
  deps: ResolveWebProviderRuntimeDeps<TEntry>,
): TEntry[] {
  const runtimeRegistry = resolveRuntimePluginRegistry(
    params.config === undefined ? undefined : resolveWebProviderLoadOptions(params, deps),
  );
  if (runtimeRegistry) {
    return deps.mapRegistryProviders({
      onlyPluginIds: params.onlyPluginIds,
      registry: runtimeRegistry,
    });
  }
  return resolvePluginWebProviders(params, deps);
}
