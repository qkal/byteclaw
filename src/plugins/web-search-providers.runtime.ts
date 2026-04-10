import type { loadOpenClawPlugins } from "./loader.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
import {
  mapRegistryProviders,
  resolveManifestDeclaredWebProviderCandidatePluginIds,
} from "./web-provider-resolution-shared.js";
import {
  createWebProviderSnapshotCache,
  resolvePluginWebProviders,
  resolveRuntimeWebProviders,
} from "./web-provider-runtime-shared.js";
import {
  resolveBundledWebSearchResolutionConfig,
  sortWebSearchProviders,
} from "./web-search-providers.shared.js";

let webSearchProviderSnapshotCache = createWebProviderSnapshotCache<PluginWebSearchProviderEntry>();

function resetWebSearchProviderSnapshotCacheForTests() {
  webSearchProviderSnapshotCache = createWebProviderSnapshotCache<PluginWebSearchProviderEntry>();
}

export const __testing = {
  resetWebSearchProviderSnapshotCacheForTests,
} as const;

function resolveWebSearchCandidatePluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
}): string[] | undefined {
  return resolveManifestDeclaredWebProviderCandidatePluginIds({
    config: params.config,
    configKey: "webSearch",
    contract: "webSearchProviders",
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
  });
}

function mapRegistryWebSearchProviders(params: {
  registry: ReturnType<typeof loadOpenClawPlugins>;
  onlyPluginIds?: readonly string[];
}): PluginWebSearchProviderEntry[] {
  return mapRegistryProviders({
    entries: params.registry.webSearchProviders,
    onlyPluginIds: params.onlyPluginIds,
    sortProviders: sortWebSearchProviders,
  });
}

export function resolvePluginWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  mode?: "runtime" | "setup";
  origin?: PluginManifestRecord["origin"];
}): PluginWebSearchProviderEntry[] {
  return resolvePluginWebProviders(params, {
    mapRegistryProviders: mapRegistryWebSearchProviders,
    resolveBundledResolutionConfig: resolveBundledWebSearchResolutionConfig,
    resolveCandidatePluginIds: resolveWebSearchCandidatePluginIds,
    snapshotCache: webSearchProviderSnapshotCache,
  });
}

export function resolveRuntimeWebSearchProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  bundledAllowlistCompat?: boolean;
  onlyPluginIds?: readonly string[];
  origin?: PluginManifestRecord["origin"];
}): PluginWebSearchProviderEntry[] {
  return resolveRuntimeWebProviders(params, {
    mapRegistryProviders: mapRegistryWebSearchProviders,
    resolveBundledResolutionConfig: resolveBundledWebSearchResolutionConfig,
    resolveCandidatePluginIds: resolveWebSearchCandidatePluginIds,
    snapshotCache: webSearchProviderSnapshotCache,
  });
}
