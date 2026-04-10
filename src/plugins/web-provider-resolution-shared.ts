import { resolveBundledPluginCompatibleActivationInputs } from "./activation-context.js";
import type { NormalizedPluginsConfig } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import {
  type PluginManifestRecord,
  loadPluginManifestRegistry,
  resolveManifestContractPluginIds,
} from "./manifest-registry.js";

export type WebProviderContract = "webSearchProviders" | "webFetchProviders";
export type WebProviderConfigKey = "webSearch" | "webFetch";

interface WebProviderSortEntry {
  id: string;
  pluginId: string;
  autoDetectOrder?: number;
}

function comparePluginProvidersAlphabetically(
  left: Pick<WebProviderSortEntry, "id" | "pluginId">,
  right: Pick<WebProviderSortEntry, "id" | "pluginId">,
): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortPluginProviders<T extends Pick<WebProviderSortEntry, "id" | "pluginId">>(
  providers: T[],
): T[] {
  return providers.toSorted(comparePluginProvidersAlphabetically);
}

export function sortPluginProvidersForAutoDetect<T extends WebProviderSortEntry>(
  providers: T[],
): T[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return comparePluginProvidersAlphabetically(left, right);
  });
}

function pluginManifestDeclaresProviderConfig(
  record: PluginManifestRecord,
  configKey: WebProviderConfigKey,
  contract: WebProviderContract,
): boolean {
  if ((record.contracts?.[contract]?.length ?? 0) > 0) {
    return true;
  }
  const configUiHintKeys = Object.keys(record.configUiHints ?? {});
  if (configUiHintKeys.some((key) => key === configKey || key.startsWith(`${configKey}.`))) {
    return true;
  }
  const properties = record.configSchema?.properties;
  return typeof properties === "object" && properties !== null && configKey in properties;
}

export function resolveManifestDeclaredWebProviderCandidatePluginIds(params: {
  contract: WebProviderContract;
  configKey: WebProviderConfigKey;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
}): string[] | undefined {
  const contractIds = new Set(
    resolveManifestContractPluginIds({
      config: params.config,
      contract: params.contract,
      env: params.env,
      onlyPluginIds: params.onlyPluginIds,
      origin: params.origin,
      workspaceDir: params.workspaceDir,
    }),
  );
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  const ids = loadPluginManifestRegistry({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
  })
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        (contractIds.has(plugin.id) ||
          pluginManifestDeclaresProviderConfig(plugin, params.configKey, params.contract)),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  return ids.length > 0 ? ids : undefined;
}

function resolveBundledWebProviderCompatPluginIds(params: {
  contract: WebProviderContract;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[] {
  return resolveManifestContractPluginIds({
    config: params.config,
    contract: params.contract,
    env: params.env,
    origin: "bundled",
    workspaceDir: params.workspaceDir,
  });
}

export function resolveBundledWebProviderResolutionConfig(params: {
  contract: WebProviderContract;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
}): {
  config: PluginLoadOptions["config"];
  normalized: NormalizedPluginsConfig;
  activationSourceConfig?: PluginLoadOptions["config"];
  autoEnabledReasons: Record<string, string[]>;
} {
  const activation = resolveBundledPluginCompatibleActivationInputs({
    applyAutoEnable: true,
    compatMode: {
      allowlist: params.bundledAllowlistCompat,
      enablement: "always",
      vitest: true,
    },
    env: params.env,
    rawConfig: params.config,
    resolveCompatPluginIds: (compatParams) =>
      resolveBundledWebProviderCompatPluginIds({
        contract: params.contract,
        ...compatParams,
      }),
    workspaceDir: params.workspaceDir,
  });

  return {
    activationSourceConfig: activation.activationSourceConfig,
    autoEnabledReasons: activation.autoEnabledReasons,
    config: activation.config,
    normalized: activation.normalized,
  };
}

export function buildWebProviderSnapshotCacheKey(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
  envKey: string | Record<string, string>;
}): string {
  const envKey =
    typeof params.envKey === "string"
      ? params.envKey
      : Object.entries(params.envKey).toSorted(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    bundledAllowlistCompat: params.bundledAllowlistCompat === true,
    env: envKey,
    onlyPluginIds: [...new Set(params.onlyPluginIds ?? [])].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    origin: params.origin ?? "",
    workspaceDir: params.workspaceDir ?? "",
  });
}

export function mapRegistryProviders<
  TProvider extends { id: string },
  TEntry extends { pluginId: string; provider: TProvider },
>(params: {
  entries: readonly TEntry[];
  onlyPluginIds?: readonly string[];
  sortProviders: (
    providers: (TProvider & { pluginId: string })[],
  ) => (TProvider & { pluginId: string })[];
}): (TProvider & { pluginId: string })[] {
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  return params.sortProviders(
    params.entries
      .filter((entry) => !onlyPluginIdSet || onlyPluginIdSet.has(entry.pluginId))
      .map((entry) => ({
        ...entry.provider,
        pluginId: entry.pluginId,
      })),
  );
}
