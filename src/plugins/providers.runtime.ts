import { withActivatedPluginIds } from "./activation-context.js";
import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
import {
  type PluginLoadOptions,
  isPluginRegistryLoadInFlight,
  loadOpenClawPlugins,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import {
  resolveBundledProviderCompatPluginIds,
  resolveDiscoveredProviderPluginIds,
  resolveEnabledProviderPluginIds,
  resolveOwningPluginIdsForModelRefs,
  resolveOwningPluginIdsForProvider,
  withBundledProviderVitestCompat,
} from "./providers.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";
import {
  buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger,
} from "./runtime/load-context.js";
import type { ProviderPlugin } from "./types.js";

function resolvePluginProviderLoadBase(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
}) {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDir();
  const providerOwnedPluginIds = params.providerRefs?.length
    ? [
        ...new Set(
          params.providerRefs.flatMap(
            (provider) =>
              resolveOwningPluginIdsForProvider({
                config: params.config,
                env,
                provider,
                workspaceDir,
              }) ?? [],
          ),
        ),
      ]
    : [];
  const modelOwnedPluginIds = params.modelRefs?.length
    ? resolveOwningPluginIdsForModelRefs({
        config: params.config,
        env,
        models: params.modelRefs,
        workspaceDir,
      })
    : [];
  const requestedPluginIds =
    params.onlyPluginIds ||
    params.providerRefs?.length ||
    params.modelRefs?.length ||
    providerOwnedPluginIds.length > 0 ||
    modelOwnedPluginIds.length > 0
      ? [
          ...new Set([
            ...(params.onlyPluginIds ?? []),
            ...providerOwnedPluginIds,
            ...modelOwnedPluginIds,
          ]),
        ].toSorted((left, right) => left.localeCompare(right))
      : undefined;
  const runtimeConfig = withActivatedPluginIds({
    config: params.config,
    pluginIds: [...providerOwnedPluginIds, ...modelOwnedPluginIds],
  });
  return {
    env,
    requestedPluginIds,
    runtimeConfig,
    workspaceDir,
  };
}

function resolveSetupProviderPluginLoadState(
  params: Parameters<typeof resolvePluginProviders>[0],
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
) {
  const providerPluginIds = resolveDiscoveredProviderPluginIds({
    config: base.runtimeConfig,
    env: base.env,
    includeUntrustedWorkspacePlugins: params.includeUntrustedWorkspacePlugins,
    onlyPluginIds: base.requestedPluginIds,
    workspaceDir: base.workspaceDir,
  });
  if (providerPluginIds.length === 0) {
    return undefined;
  }
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      activationSourceConfig: base.runtimeConfig,
      autoEnabledReasons: {},
      config: withActivatedPluginIds({
        config: base.runtimeConfig,
        pluginIds: providerPluginIds,
      }),
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
      workspaceDir: base.workspaceDir,
    },
    {
      activate: params.activate ?? false,
      cache: params.cache ?? false,
      onlyPluginIds: providerPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
    },
  );
  return { loadOptions };
}

function resolveRuntimeProviderPluginLoadState(
  params: Parameters<typeof resolvePluginProviders>[0],
  base: ReturnType<typeof resolvePluginProviderLoadBase>,
) {
  const activation = resolveBundledPluginCompatibleActivationInputs({
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledProviderAllowlistCompat,
      enablement: "allowlist",
      vitest: params.bundledProviderVitestCompat,
    },
    env: base.env,
    onlyPluginIds: base.requestedPluginIds,
    rawConfig: base.runtimeConfig,
    resolveCompatPluginIds: resolveBundledProviderCompatPluginIds,
    workspaceDir: base.workspaceDir,
  });
  const config = params.bundledProviderVitestCompat
    ? withBundledProviderVitestCompat({
        config: activation.config,
        env: base.env,
        pluginIds: activation.compatPluginIds,
      })
    : activation.config;
  const providerPluginIds = resolveEnabledProviderPluginIds({
    config,
    env: base.env,
    onlyPluginIds: base.requestedPluginIds,
    workspaceDir: base.workspaceDir,
  });
  const loadOptions = buildPluginRuntimeLoadOptionsFromValues(
    {
      activationSourceConfig: activation.activationSourceConfig,
      autoEnabledReasons: activation.autoEnabledReasons,
      config,
      env: base.env,
      logger: createPluginRuntimeLoaderLogger(),
      workspaceDir: base.workspaceDir,
    },
    {
      activate: params.activate ?? false,
      cache: params.cache ?? false,
      onlyPluginIds: providerPluginIds,
      pluginSdkResolution: params.pluginSdkResolution,
    },
  );
  return { loadOptions };
}

export function isPluginProvidersLoadInFlight(
  params: Parameters<typeof resolvePluginProviders>[0],
): boolean {
  const base = resolvePluginProviderLoadBase(params);
  const loadState =
    params.mode === "setup"
      ? resolveSetupProviderPluginLoadState(params, base)
      : resolveRuntimeProviderPluginLoadState(params, base);
  if (!loadState) {
    return false;
  }
  return isPluginRegistryLoadInFlight(loadState.loadOptions);
}

export function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
  mode?: "runtime" | "setup";
  includeUntrustedWorkspacePlugins?: boolean;
}): ProviderPlugin[] {
  const base = resolvePluginProviderLoadBase(params);
  if (params.mode === "setup") {
    const loadState = resolveSetupProviderPluginLoadState(params, base);
    if (!loadState) {
      return [];
    }
    const registry = loadOpenClawPlugins(loadState.loadOptions);
    return registry.providers.map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    }));
  }
  const loadState = resolveRuntimeProviderPluginLoadState(params, base);
  const registry = resolveRuntimePluginRegistry(loadState.loadOptions);
  if (!registry) {
    return [];
  }

  return registry.providers.map((entry) => ({
    ...entry.provider,
    pluginId: entry.pluginId,
  }));
}
