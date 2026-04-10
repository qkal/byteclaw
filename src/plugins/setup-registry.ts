import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildPluginApi } from "./api-builder.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { type PluginJitiLoaderCache, getCachedPluginJitiLoader } from "./jiti-loader-cache.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  CliBackendPlugin,
  OpenClawPluginModule,
  PluginConfigMigration,
  PluginLogger,
  PluginSetupAutoEnableProbe,
  ProviderPlugin,
} from "./types.js";

const SETUP_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

interface SetupProviderEntry {
  pluginId: string;
  provider: ProviderPlugin;
}

interface SetupCliBackendEntry {
  pluginId: string;
  backend: CliBackendPlugin;
}

interface SetupConfigMigrationEntry {
  pluginId: string;
  migrate: PluginConfigMigration;
}

interface SetupAutoEnableProbeEntry {
  pluginId: string;
  probe: PluginSetupAutoEnableProbe;
}

interface PluginSetupRegistry {
  providers: SetupProviderEntry[];
  cliBackends: SetupCliBackendEntry[];
  configMigrations: SetupConfigMigrationEntry[];
  autoEnableProbes: SetupAutoEnableProbeEntry[];
}

interface SetupAutoEnableReason {
  pluginId: string;
  reason: string;
}

const EMPTY_RUNTIME = {} as PluginRuntime;
const NOOP_LOGGER: PluginLogger = {
  error() {},
  info() {},
  warn() {},
};

const jitiLoaders: PluginJitiLoaderCache = new Map();
const setupRegistryCache = new Map<string, PluginSetupRegistry>();
const setupProviderCache = new Map<string, ProviderPlugin | null>();

export function clearPluginSetupRegistryCache(): void {
  jitiLoaders.clear();
  setupRegistryCache.clear();
  setupProviderCache.clear();
}

function getJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    importerUrl: import.meta.url,
    modulePath,
  });
}

function buildSetupRegistryCacheKey(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    env: params.env,
    workspaceDir: params.workspaceDir,
  });
  return JSON.stringify({
    loadPaths,
    pluginIds: params.pluginIds ? [...new Set(params.pluginIds)].toSorted() : null,
    roots,
  });
}

function buildSetupProviderCacheKey(params: {
  provider: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return JSON.stringify({
    provider: normalizeProviderId(params.provider),
    registry: buildSetupRegistryCacheKey(params),
  });
}

function resolveSetupApiPath(rootDir: string): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? SETUP_API_EXTENSIONS
    : ([...SETUP_API_EXTENSIONS.slice(3), ...SETUP_API_EXTENSIONS.slice(0, 3)] as const);

  const findSetupApi = (candidateRootDir: string): string | null => {
    for (const extension of orderedExtensions) {
      const candidate = path.join(candidateRootDir, `setup-api${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const direct = findSetupApi(rootDir);
  if (direct) {
    return direct;
  }

  const bundledExtensionDir = path.basename(rootDir);
  const repoRootCandidates = [
    path.resolve(path.dirname(CURRENT_MODULE_PATH), "..", ".."),
    process.cwd(),
  ];
  for (const repoRoot of repoRootCandidates) {
    const sourceExtensionRoot = path.join(repoRoot, "extensions", bundledExtensionDir);
    if (sourceExtensionRoot === rootDir) {
      continue;
    }
    const sourceFallback = findSetupApi(sourceExtensionRoot);
    if (sourceFallback) {
      return sourceFallback;
    }
  }

  return null;
}

function collectConfiguredPluginEntryIds(config: OpenClawConfig): string[] {
  const entries = config.plugins?.entries;
  if (!entries || typeof entries !== "object") {
    return [];
  }
  return Object.keys(entries)
    .map((pluginId) => pluginId.trim())
    .filter(Boolean)
    .toSorted();
}

function resolveRelevantSetupMigrationPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const ids = new Set<string>(collectConfiguredPluginEntryIds(params.config));
  const registry = loadPluginManifestRegistry({
    cache: true,
    env: params.env,
    workspaceDir: params.workspaceDir,
  });
  for (const plugin of registry.plugins) {
    const paths = plugin.configContracts?.compatibilityMigrationPaths;
    if (!paths?.length) {
      continue;
    }
    if (
      paths.some(
        (pathPattern) =>
          collectPluginConfigContractMatches({
            pathPattern,
            root: params.config,
          }).length > 0,
      )
    ) {
      ids.add(plugin.id);
    }
  }
  return [...ids].toSorted();
}

function resolveRegister(mod: OpenClawPluginModule): {
  definition?: { id?: string };
  register?: (api: ReturnType<typeof buildPluginApi>) => void | Promise<void>;
} {
  if (typeof mod === "function") {
    return { register: mod };
  }
  if (mod && typeof mod === "object" && typeof mod.register === "function") {
    return {
      definition: mod as { id?: string },
      register: mod.register.bind(mod),
    };
  }
  return {};
}

function matchesProvider(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

export function resolvePluginSetupRegistry(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginSetupRegistry {
  const env = params?.env ?? process.env;
  const cacheKey = buildSetupRegistryCacheKey({
    env,
    pluginIds: params?.pluginIds,
    workspaceDir: params?.workspaceDir,
  });
  const cached = setupRegistryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const selectedPluginIds = params?.pluginIds
    ? new Set(params.pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean))
    : null;
  if (selectedPluginIds && selectedPluginIds.size === 0) {
    const empty = {
      autoEnableProbes: [],
      cliBackends: [],
      configMigrations: [],
      providers: [],
    } satisfies PluginSetupRegistry;
    setupRegistryCache.set(cacheKey, empty);
    return empty;
  }

  const providers: SetupProviderEntry[] = [];
  const cliBackends: SetupCliBackendEntry[] = [];
  const configMigrations: SetupConfigMigrationEntry[] = [];
  const autoEnableProbes: SetupAutoEnableProbeEntry[] = [];
  const providerKeys = new Set<string>();
  const cliBackendKeys = new Set<string>();

  const discovery = discoverOpenClawPlugins({
    cache: true,
    env,
    workspaceDir: params?.workspaceDir,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    env,
    workspaceDir: params?.workspaceDir,
  });

  for (const record of manifestRegistry.plugins) {
    if (selectedPluginIds && !selectedPluginIds.has(record.id)) {
      continue;
    }
    const setupSource = record.setupSource ?? resolveSetupApiPath(record.rootDir);
    if (!setupSource) {
      continue;
    }

    let mod: OpenClawPluginModule;
    try {
      mod = getJiti(setupSource)(setupSource) as OpenClawPluginModule;
    } catch {
      continue;
    }

    const resolved = resolveRegister((mod as { default?: OpenClawPluginModule }).default ?? mod);
    if (!resolved.register) {
      continue;
    }
    if (resolved.definition?.id && resolved.definition.id !== record.id) {
      continue;
    }

    const api = buildPluginApi({
      config: {} as OpenClawConfig,
      description: record.description,
      handlers: {
        registerAutoEnableProbe(probe) {
          autoEnableProbes.push({
            pluginId: record.id,
            probe,
          });
        },
        registerCliBackend(backend) {
          const key = `${record.id}:${normalizeProviderId(backend.id)}`;
          if (cliBackendKeys.has(key)) {
            return;
          }
          cliBackendKeys.add(key);
          cliBackends.push({
            backend,
            pluginId: record.id,
          });
        },
        registerConfigMigration(migrate) {
          configMigrations.push({
            migrate,
            pluginId: record.id,
          });
        },
        registerProvider(provider) {
          const key = `${record.id}:${normalizeProviderId(provider.id)}`;
          if (providerKeys.has(key)) {
            return;
          }
          providerKeys.add(key);
          providers.push({
            pluginId: record.id,
            provider,
          });
        },
      },
      id: record.id,
      logger: NOOP_LOGGER,
      name: record.name ?? record.id,
      registrationMode: "setup-only",
      resolvePath: (input) => input,
      rootDir: record.rootDir,
      runtime: EMPTY_RUNTIME,
      source: setupSource,
      version: record.version,
    });

    try {
      const result = resolved.register(api);
      if (result && typeof result.then === "function") {
        // Keep setup registration sync-only.
      }
    } catch {
      continue;
    }
  }

  const registry = {
    autoEnableProbes,
    cliBackends,
    configMigrations,
    providers,
  } satisfies PluginSetupRegistry;
  setupRegistryCache.set(cacheKey, registry);
  return registry;
}

export function resolvePluginSetupProvider(params: {
  provider: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  const cacheKey = buildSetupProviderCacheKey(params);
  if (setupProviderCache.has(cacheKey)) {
    return setupProviderCache.get(cacheKey) ?? undefined;
  }

  const env = params.env ?? process.env;
  const normalizedProvider = normalizeProviderId(params.provider);
  const discovery = discoverOpenClawPlugins({
    cache: true,
    env,
    workspaceDir: params.workspaceDir,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    env,
    workspaceDir: params.workspaceDir,
  });
  const record = manifestRegistry.plugins.find((entry) =>
    entry.providers.some((providerId) => normalizeProviderId(providerId) === normalizedProvider),
  );
  if (!record) {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  const setupSource = record.setupSource ?? resolveSetupApiPath(record.rootDir);
  if (!setupSource) {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  let mod: OpenClawPluginModule;
  try {
    mod = getJiti(setupSource)(setupSource) as OpenClawPluginModule;
  } catch {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  const resolved = resolveRegister((mod as { default?: OpenClawPluginModule }).default ?? mod);
  if (!resolved.register) {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }
  if (resolved.definition?.id && resolved.definition.id !== record.id) {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  let matchedProvider: ProviderPlugin | undefined;
  const localProviderKeys = new Set<string>();
  const api = buildPluginApi({
    config: {} as OpenClawConfig,
    description: record.description,
    handlers: {
      registerAutoEnableProbe() {},
      registerConfigMigration() {},
      registerProvider(provider) {
        const key = normalizeProviderId(provider.id);
        if (localProviderKeys.has(key)) {
          return;
        }
        localProviderKeys.add(key);
        if (matchesProvider(provider, normalizedProvider)) {
          matchedProvider = provider;
        }
      },
    },
    id: record.id,
    logger: NOOP_LOGGER,
    name: record.name ?? record.id,
    registrationMode: "setup-only",
    resolvePath: (input) => input,
    rootDir: record.rootDir,
    runtime: EMPTY_RUNTIME,
    source: setupSource,
    version: record.version,
  });

  try {
    const result = resolved.register(api);
    if (result && typeof result.then === "function") {
      // Keep setup registration sync-only.
    }
  } catch {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  setupProviderCache.set(cacheKey, matchedProvider ?? null);
  return matchedProvider;
}

export function resolvePluginSetupCliBackend(params: {
  backend: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): SetupCliBackendEntry | undefined {
  const normalized = normalizeProviderId(params.backend);
  const direct = resolvePluginSetupRegistry(params).cliBackends.find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
  if (direct) {
    return direct;
  }

  const env = params.env ?? process.env;
  const discovery = discoverOpenClawPlugins({
    cache: true,
    env,
    workspaceDir: params.workspaceDir,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    env,
    workspaceDir: params.workspaceDir,
  });
  const record = manifestRegistry.plugins.find((entry) =>
    entry.cliBackends.some((backendId) => normalizeProviderId(backendId) === normalized),
  );
  if (!record) {
    return undefined;
  }

  const setupSource = record.setupSource ?? resolveSetupApiPath(record.rootDir);
  if (!setupSource) {
    return undefined;
  }

  let mod: OpenClawPluginModule;
  try {
    mod = getJiti(setupSource)(setupSource) as OpenClawPluginModule;
  } catch {
    return undefined;
  }
  const resolved = resolveRegister((mod as { default?: OpenClawPluginModule }).default ?? mod);
  if (!resolved.register) {
    return undefined;
  }
  if (resolved.definition?.id && resolved.definition.id !== record.id) {
    return undefined;
  }

  let matchedBackend: CliBackendPlugin | undefined;
  const localBackendKeys = new Set<string>();
  const api = buildPluginApi({
    config: {} as OpenClawConfig,
    description: record.description,
    handlers: {
      registerAutoEnableProbe() {},
      registerCliBackend(backend) {
        const key = normalizeProviderId(backend.id);
        if (localBackendKeys.has(key)) {
          return;
        }
        localBackendKeys.add(key);
        if (key === normalized) {
          matchedBackend = backend;
        }
      },
      registerConfigMigration() {},
      registerProvider() {},
    },
    id: record.id,
    logger: NOOP_LOGGER,
    name: record.name ?? record.id,
    registrationMode: "setup-only",
    resolvePath: (input) => input,
    rootDir: record.rootDir,
    runtime: EMPTY_RUNTIME,
    source: setupSource,
    version: record.version,
  });

  try {
    const result = resolved.register(api);
    if (result && typeof result.then === "function") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return matchedBackend ? { backend: matchedBackend, pluginId: record.id } : undefined;
}

export function runPluginSetupConfigMigrations(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next = params.config;
  const changes: string[] = [];
  const pluginIds = resolveRelevantSetupMigrationPluginIds(params);
  if (pluginIds.length === 0) {
    return { changes, config: next };
  }

  for (const entry of resolvePluginSetupRegistry({
    env: params.env,
    pluginIds,
    workspaceDir: params.workspaceDir,
  }).configMigrations) {
    const migration = entry.migrate(next);
    if (!migration || migration.changes.length === 0) {
      continue;
    }
    next = migration.config;
    changes.push(...migration.changes);
  }

  return { changes, config: next };
}

export function resolvePluginSetupAutoEnableReasons(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): SetupAutoEnableReason[] {
  const env = params.env ?? process.env;
  const reasons: SetupAutoEnableReason[] = [];
  const seen = new Set<string>();

  for (const entry of resolvePluginSetupRegistry({
    env,
    workspaceDir: params.workspaceDir,
  }).autoEnableProbes) {
    const raw = entry.probe({
      config: params.config,
      env,
    });
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const reason of values) {
      const normalized = reason.trim();
      if (!normalized) {
        continue;
      }
      const key = `${entry.pluginId}:${normalized}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      reasons.push({
        pluginId: entry.pluginId,
        reason: normalized,
      });
    }
  }

  return reasons;
}
