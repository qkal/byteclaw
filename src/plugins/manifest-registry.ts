import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeOptionalTrimmedStringList } from "../shared/string-normalization.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import {
  type NormalizedPluginsConfig,
  normalizePluginsConfigWithResolver,
} from "./config-policy.js";
import { type PluginCandidate, discoverOpenClawPlugins } from "./discovery.js";
import {
  type OpenClawPackageManifest,
  type PluginManifest,
  type PluginManifestChannelConfig,
  type PluginManifestConfigContracts,
  type PluginManifestContracts,
  type PluginManifestModelSupport,
  loadPluginManifest,
} from "./manifest.js";
import { checkMinHostVersion } from "./min-host-version.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import { resolvePluginCacheInputs } from "./roots.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
  PluginKind,
  PluginOrigin,
} from "./types.js";

type PluginManifestContractListKey =
  | "speechProviders"
  | "mediaUnderstandingProviders"
  | "realtimeVoiceProviders"
  | "realtimeTranscriptionProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "memoryEmbeddingProviders"
  | "webFetchProviders"
  | "webSearchProviders";

interface SeenIdEntry {
  candidate: PluginCandidate;
  recordIndex: number;
}

// Canonicalize identical physical plugin roots with the most explicit source.
// This only applies when multiple candidates resolve to the same on-disk plugin.
const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  bundled: 3,
  config: 0,
  global: 2,
  workspace: 1,
};

export interface PluginManifestRecord {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  enabledByDefault?: boolean;
  autoEnableWhenConfiguredProviders?: string[];
  legacyPluginIds?: string[];
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind | PluginKind[];
  channels: string[];
  providers: string[];
  providerDiscoverySource?: string;
  modelSupport?: PluginManifestModelSupport;
  cliBackends: string[];
  providerAuthEnvVars?: Record<string, string[]>;
  providerAuthAliases?: Record<string, string>;
  channelEnvVars?: Record<string, string[]>;
  providerAuthChoices?: PluginManifest["providerAuthChoices"];
  skills: string[];
  settingsFiles?: string[];
  hooks: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  setupSource?: string;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
  contracts?: PluginManifestContracts;
  configContracts?: PluginManifestConfigContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  channelCatalogMeta?: {
    id: string;
    label?: string;
    blurb?: string;
    preferOver?: readonly string[];
  };
}

export interface PluginManifestRegistry {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
}

const registryCache = new Map<string, { expiresAt: number; registry: PluginManifestRegistry }>();

// Keep a short cache window to collapse bursty reloads during startup flows.
const DEFAULT_MANIFEST_CACHE_MS = 1000;

export function clearPluginManifestRegistryCache(): void {
  registryCache.clear();
}

function listContractValues(
  plugin: PluginManifestRecord,
  contract: PluginManifestContractListKey,
): readonly string[] {
  return plugin.contracts?.[contract] ?? [];
}

export function resolveManifestContractPluginIds(params: {
  contract: PluginManifestContractListKey;
  origin?: PluginOrigin;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): string[] {
  const onlyPluginIdSet =
    params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
  return loadPluginManifestRegistry({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
  })
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        listContractValues(plugin, params.contract).length > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveManifestContractPluginIdsByCompatibilityRuntimePath(params: {
  contract: PluginManifestContractListKey;
  path: string | undefined;
  origin?: PluginOrigin;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const normalizedPath = params.path?.trim();
  if (!normalizedPath) {
    return [];
  }
  return loadPluginManifestRegistry({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
  })
    .plugins.filter(
      (plugin) =>
        (!params.origin || plugin.origin === params.origin) &&
        listContractValues(plugin, params.contract).length > 0 &&
        (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(normalizedPath),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveManifestContractOwnerPluginId(params: {
  contract: PluginManifestContractListKey;
  value: string | undefined;
  origin?: PluginOrigin;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const normalizedValue = normalizeOptionalLowercaseString(params.value);
  if (!normalizedValue) {
    return undefined;
  }
  return loadPluginManifestRegistry({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
  }).plugins.find(
    (plugin) =>
      (!params.origin || plugin.origin === params.origin) &&
      listContractValues(plugin, params.contract).some(
        (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedValue,
      ),
  )?.id;
}

function resolveManifestCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_MANIFEST_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MANIFEST_CACHE_MS;
  }
  return Math.max(0, parsed);
}

function shouldUseManifestCache(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim();
  if (disabled) {
    return false;
  }
  return resolveManifestCacheMs(env) > 0;
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  env: NodeJS.ProcessEnv;
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    env: params.env,
    loadPaths: params.plugins.loadPaths,
    workspaceDir: params.workspaceDir,
  });
  const workspaceKey = roots.workspace ?? "";
  const configExtensionsRoot = roots.global;
  const bundledRoot = roots.stock ?? "";
  const runtimeServiceVersion = resolveCompatibilityHostVersion(params.env);
  // The manifest registry only depends on where plugins are discovered from (workspace + load paths).
  // It does not depend on allow/deny/entries enable-state, so exclude those for higher cache hit rates.
  return `${workspaceKey}::${configExtensionsRoot}::${bundledRoot}::${runtimeServiceVersion}::${JSON.stringify(loadPaths)}`;
}

function safeStatMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function normalizePreferredPluginIds(raw: unknown): string[] | undefined {
  return normalizeOptionalTrimmedStringList(raw);
}

function mergePackageChannelMetaIntoChannelConfigs(params: {
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
  packageChannel?: OpenClawPackageManifest["channel"];
}): Record<string, PluginManifestChannelConfig> | undefined {
  const channelId = params.packageChannel?.id?.trim();
  if (!channelId || !params.channelConfigs?.[channelId]) {
    return params.channelConfigs;
  }

  const existing = params.channelConfigs[channelId];
  const label = existing.label ?? normalizeOptionalString(params.packageChannel?.label) ?? "";
  const description =
    existing.description ?? normalizeOptionalString(params.packageChannel?.blurb) ?? "";
  const preferOver =
    existing.preferOver ?? normalizePreferredPluginIds(params.packageChannel?.preferOver);

  return {
    ...params.channelConfigs,
    [channelId]: {
      ...existing,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(preferOver?.length ? { preferOver } : {}),
    },
  };
}

function buildRecord(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
}): PluginManifestRecord {
  const channelConfigs = mergePackageChannelMetaIntoChannelConfigs({
    channelConfigs: params.manifest.channelConfigs,
    packageChannel: params.candidate.packageManifest?.channel,
  });
  return {
    autoEnableWhenConfiguredProviders: params.manifest.autoEnableWhenConfiguredProviders,
    bundleFormat: params.candidate.bundleFormat,
    channelConfigs,
    channelEnvVars: params.manifest.channelEnvVars,
    channels: params.manifest.channels ?? [],
    cliBackends: params.manifest.cliBackends ?? [],
    configContracts: params.manifest.configContracts,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
    contracts: params.manifest.contracts,
    description:
      normalizeOptionalString(params.manifest.description) ?? params.candidate.packageDescription,
    enabledByDefault: params.manifest.enabledByDefault === true ? true : undefined,
    format: params.candidate.format ?? "openclaw",
    hooks: [],
    id: params.manifest.id,
    kind: params.manifest.kind,
    legacyPluginIds: params.manifest.legacyPluginIds,
    manifestPath: params.manifestPath,
    modelSupport: params.manifest.modelSupport,
    name: normalizeOptionalString(params.manifest.name) ?? params.candidate.packageName,
    origin: params.candidate.origin,
    providerAuthAliases: params.manifest.providerAuthAliases,
    providerAuthChoices: params.manifest.providerAuthChoices,
    providerAuthEnvVars: params.manifest.providerAuthEnvVars,
    providerDiscoverySource: params.manifest.providerDiscoveryEntry
      ? path.resolve(params.candidate.rootDir, params.manifest.providerDiscoveryEntry)
      : undefined,
    providers: params.manifest.providers ?? [],
    rootDir: params.candidate.rootDir,
    schemaCacheKey: params.schemaCacheKey,
    settingsFiles: [],
    setupSource: params.candidate.setupSource,
    skills: params.manifest.skills ?? [],
    source: params.candidate.source,
    startupDeferConfiguredChannelFullLoadUntilAfterListen:
      params.candidate.packageManifest?.startup?.deferConfiguredChannelFullLoadUntilAfterListen ===
      true,
    version: normalizeOptionalString(params.manifest.version) ?? params.candidate.packageVersion,
    workspaceDir: params.candidate.workspaceDir,
    ...(params.candidate.packageManifest?.channel?.id
      ? {
          channelCatalogMeta: {
            id: params.candidate.packageManifest.channel.id,
            ...(typeof params.candidate.packageManifest.channel.label === "string"
              ? { label: params.candidate.packageManifest.channel.label }
              : {}),
            ...(typeof params.candidate.packageManifest.channel.blurb === "string"
              ? { blurb: params.candidate.packageManifest.channel.blurb }
              : {}),
            ...(params.candidate.packageManifest.channel.preferOver
              ? { preferOver: params.candidate.packageManifest.channel.preferOver }
              : {}),
          },
        }
      : {}),
  };
}

function buildBundleRecord(params: {
  manifest: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    skills: string[];
    settingsFiles?: string[];
    hooks: string[];
    capabilities: string[];
  };
  candidate: PluginCandidate;
  manifestPath: string;
}): PluginManifestRecord {
  return {
    bundleCapabilities: params.manifest.capabilities,
    bundleFormat: params.candidate.bundleFormat,
    channelConfigs: undefined,
    channels: [],
    cliBackends: [],
    configContracts: undefined,
    configSchema: undefined,
    configUiHints: undefined,
    description: normalizeOptionalString(params.manifest.description),
    format: "bundle",
    hooks: params.manifest.hooks ?? [],
    id: params.manifest.id,
    manifestPath: params.manifestPath,
    name: normalizeOptionalString(params.manifest.name) ?? params.candidate.idHint,
    origin: params.candidate.origin,
    providers: [],
    rootDir: params.candidate.rootDir,
    schemaCacheKey: undefined,
    settingsFiles: params.manifest.settingsFiles ?? [],
    skills: params.manifest.skills ?? [],
    source: params.candidate.source,
    version: normalizeOptionalString(params.manifest.version),
    workspaceDir: params.candidate.workspaceDir,
  };
}

function matchesInstalledPluginRecord(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.candidate.origin !== "global") {
    return false;
  }
  const record = params.config?.plugins?.installs?.[params.pluginId];
  if (!record) {
    return false;
  }
  const candidateSource = resolveUserPath(params.candidate.source, params.env);
  const trackedPaths = [record.installPath, record.sourcePath]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => resolveUserPath(entry, params.env));
  if (trackedPaths.length === 0) {
    return false;
  }
  return trackedPaths.some(
    (trackedPath) => candidateSource === trackedPath || isPathInside(trackedPath, candidateSource),
  );
}

function resolveDuplicatePrecedenceRank(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): number {
  if (params.candidate.origin === "config") {
    return 0;
  }
  if (
    params.candidate.origin === "global" &&
    matchesInstalledPluginRecord({
      candidate: params.candidate,
      config: params.config,
      env: params.env,
      pluginId: params.pluginId,
    })
  ) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids are reserved unless the operator explicitly overrides them.
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

export function loadPluginManifestRegistry(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    cache?: boolean;
    env?: NodeJS.ProcessEnv;
    candidates?: PluginCandidate[];
    diagnostics?: PluginDiagnostic[];
  } = {},
): PluginManifestRegistry {
  const config = params.config ?? {};
  const normalized = normalizePluginsConfigWithResolver(config.plugins);
  const env = params.env ?? process.env;
  const cacheKey = buildCacheKey({ env, plugins: normalized, workspaceDir: params.workspaceDir });
  const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.registry;
    }
  }

  const discovery = params.candidates
    ? {
        candidates: params.candidates,
        diagnostics: params.diagnostics ?? [],
      }
    : discoverOpenClawPlugins({
        cache: params.cache,
        env,
        extraPaths: normalized.loadPaths,
        workspaceDir: params.workspaceDir,
      });
  const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
  const { candidates } = discovery;
  const records: PluginManifestRecord[] = [];
  const seenIds = new Map<string, SeenIdEntry>();
  const realpathCache = new Map<string, string>();
  const currentHostVersion = resolveCompatibilityHostVersion(env);

  for (const candidate of candidates) {
    const rejectHardlinks = candidate.origin !== "bundled";
    const isBundleRecord = (candidate.format ?? "openclaw") === "bundle";
    const manifestRes:
      | ReturnType<typeof loadPluginManifest>
      | ReturnType<typeof loadBundleManifest>
      | { ok: true; manifest: PluginManifest; manifestPath: string } =
      candidate.origin === "bundled" && candidate.bundledManifest && candidate.bundledManifestPath
        ? {
            manifest: candidate.bundledManifest,
            manifestPath: candidate.bundledManifestPath,
            ok: true,
          }
        : isBundleRecord && candidate.bundleFormat
          ? loadBundleManifest({
              bundleFormat: candidate.bundleFormat,
              rejectHardlinks,
              rootDir: candidate.rootDir,
            })
          : loadPluginManifest(candidate.rootDir, rejectHardlinks);
    if (!manifestRes.ok) {
      diagnostics.push({
        level: "error",
        message: manifestRes.error,
        source: manifestRes.manifestPath,
      });
      continue;
    }
    const { manifest } = manifestRes;
    const minHostVersionCheck = checkMinHostVersion({
      currentVersion: currentHostVersion,
      minHostVersion: candidate.packageManifest?.install?.minHostVersion,
    });
    if (!minHostVersionCheck.ok) {
      const packageManifestSource = path.join(
        candidate.packageDir ?? candidate.rootDir,
        "package.json",
      );
      diagnostics.push({
        level: minHostVersionCheck.kind === "unknown_host_version" ? "warn" : "error",
        message:
          minHostVersionCheck.kind === "invalid"
            ? `plugin manifest invalid | ${minHostVersionCheck.error}`
            : minHostVersionCheck.kind === "unknown_host_version"
              ? `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined; skipping load`
              : `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}; skipping load`,
        pluginId: manifest.id,
        source: packageManifestSource,
      });
      continue;
    }

    const configSchema = "configSchema" in manifest ? manifest.configSchema : undefined;
    const schemaCacheKey = (() => {
      if (!configSchema) {
        return undefined;
      }
      const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
      return manifestMtime
        ? `${manifestRes.manifestPath}:${manifestMtime}`
        : manifestRes.manifestPath;
    })();

    const existing = seenIds.get(manifest.id);
    if (existing) {
      // Check whether both candidates point to the same physical directory
      // (e.g. via symlinks or different path representations). If so, this
      // Is a false-positive duplicate and can be silently skipped.
      const samePath = existing.candidate.rootDir === candidate.rootDir;
      const samePlugin = (() => {
        if (samePath) {
          return true;
        }
        const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
        const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
        return Boolean(existingReal && candidateReal && existingReal === candidateReal);
      })();
      if (samePlugin) {
        // Prefer higher-precedence origins even if candidates are passed in
        // An unexpected order (config > workspace > global > bundled).
        if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
          records[existing.recordIndex] = isBundleRecord
            ? buildBundleRecord({
                candidate,
                manifest: manifest as Parameters<typeof buildBundleRecord>[0]["manifest"],
                manifestPath: manifestRes.manifestPath,
              })
            : buildRecord({
                candidate,
                configSchema,
                manifest: manifest as PluginManifest,
                manifestPath: manifestRes.manifestPath,
                schemaCacheKey,
              });
          seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
        }
        continue;
      }
      diagnostics.push({
        level: "warn",
        message:
          resolveDuplicatePrecedenceRank({
            candidate,
            config,
            env,
            pluginId: manifest.id,
          }) <
          resolveDuplicatePrecedenceRank({
            candidate: existing.candidate,
            config,
            env,
            pluginId: manifest.id,
          })
            ? `duplicate plugin id detected; ${existing.candidate.origin} plugin will be overridden by ${candidate.origin} plugin (${candidate.source})`
            : `duplicate plugin id detected; ${candidate.origin} plugin will be overridden by ${existing.candidate.origin} plugin (${candidate.source})`,
        pluginId: manifest.id,
        source: candidate.source,
      });
    } else {
      seenIds.set(manifest.id, { candidate, recordIndex: records.length });
    }

    records.push(
      isBundleRecord
        ? buildBundleRecord({
            candidate,
            manifest: manifest as Parameters<typeof buildBundleRecord>[0]["manifest"],
            manifestPath: manifestRes.manifestPath,
          })
        : buildRecord({
            candidate,
            configSchema,
            manifest: manifest as PluginManifest,
            manifestPath: manifestRes.manifestPath,
            schemaCacheKey,
          }),
    );
  }

  const registry = { diagnostics, plugins: records };
  if (cacheEnabled) {
    const ttl = resolveManifestCacheMs(env);
    if (ttl > 0) {
      registryCache.set(cacheKey, { expiresAt: Date.now() + ttl, registry });
    }
  }
  return registry;
}
