import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { buildPluginApi } from "./api-builder.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { clearPluginCommands } from "./command-registry-state.js";
import {
  clearCompactionProviders,
  listRegisteredCompactionProviders,
  restoreRegisteredCompactionProviders,
} from "./compaction-provider.js";
import {
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
  type PluginActivationState,
  applyTestPluginDefaults,
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { clearPluginInteractiveHandlers } from "./interactive-registry.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestContracts } from "./manifest.js";
import {
  clearMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviders,
  restoreRegisteredMemoryEmbeddingProviders,
} from "./memory-embedding-providers.js";
import {
  clearMemoryPluginState,
  getMemoryFlushPlanResolver,
  getMemoryPromptSectionBuilder,
  getMemoryRuntime,
  listMemoryCorpusSupplements,
  listMemoryPromptSupplements,
  restoreMemoryPluginState,
} from "./memory-state.js";
import { isPathInside, safeStatSync } from "./path-safety.js";
import { type PluginRecord, type PluginRegistry, createPluginRegistry } from "./registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
  recordImportedPluginId,
  setActivePluginRegistry,
} from "./runtime.js";
import type { CreatePluginRuntimeOptions } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import {
  type PluginSdkResolutionPreference,
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolveExtensionApiAlias,
  resolvePluginRuntimeModulePath,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";
import { hasKind, kindsEqual } from "./slots.js";
import type {
  OpenClawPluginDefinition,
  OpenClawPluginModule,
  PluginBundleFormat,
  PluginDiagnostic,
  PluginFormat,
  PluginLogger,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;

export interface PluginLoadOptions {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  // Allows callers to resolve plugin roots and load paths against an explicit env
  // Instead of the process-global environment.
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  runtimeOptions?: CreatePluginRuntimeOptions;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cache?: boolean;
  mode?: "full" | "validate";
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  /**
   * Prefer `setupEntry` for configured channel plugins that explicitly opt in
   * via package metadata because their setup entry covers the pre-listen startup surface.
   */
  preferSetupRuntimeForChannelPlugins?: boolean;
  activate?: boolean;
  loadModules?: boolean;
  throwOnLoadError?: boolean;
}

const CLI_METADATA_ENTRY_BASENAMES = [
  "cli-metadata.ts",
  "cli-metadata.js",
  "cli-metadata.mjs",
  "cli-metadata.cjs",
] as const;

export class PluginLoadFailureError extends Error {
  readonly pluginIds: string[];
  readonly registry: PluginRegistry;

  constructor(registry: PluginRegistry) {
    const failedPlugins = registry.plugins.filter((entry) => entry.status === "error");
    const summary = failedPlugins
      .map((entry) => `${entry.id}: ${entry.error ?? "unknown plugin load error"}`)
      .join("; ");
    super(`plugin load failed: ${summary}`);
    this.name = "PluginLoadFailureError";
    this.pluginIds = failedPlugins.map((entry) => entry.id);
    this.registry = registry;
  }
}

export class PluginLoadReentryError extends Error {
  readonly cacheKey: string;

  constructor(cacheKey: string) {
    super(`plugin load reentry detected for cache key: ${cacheKey}`);
    this.name = "PluginLoadReentryError";
    this.cacheKey = cacheKey;
  }
}

interface CachedPluginState {
  registry: PluginRegistry;
  memoryCorpusSupplements: ReturnType<typeof listMemoryCorpusSupplements>;
  compactionProviders: ReturnType<typeof listRegisteredCompactionProviders>;
  memoryEmbeddingProviders: ReturnType<typeof listRegisteredMemoryEmbeddingProviders>;
  memoryFlushPlanResolver: ReturnType<typeof getMemoryFlushPlanResolver>;
  memoryPromptBuilder: ReturnType<typeof getMemoryPromptSectionBuilder>;
  memoryPromptSupplements: ReturnType<typeof listMemoryPromptSupplements>;
  memoryRuntime: ReturnType<typeof getMemoryRuntime>;
}

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;
let pluginRegistryCacheEntryCap = MAX_PLUGIN_REGISTRY_CACHE_ENTRIES;
const registryCache = new Map<string, CachedPluginState>();
const inFlightPluginRegistryLoads = new Set<string>();
const openAllowlistWarningCache = new Set<string>();
const LAZY_RUNTIME_REFLECTION_KEYS = [
  "version",
  "config",
  "agent",
  "subagent",
  "system",
  "media",
  "tts",
  "stt",
  "channel",
  "events",
  "logging",
  "state",
  "modelAuth",
] as const satisfies readonly (keyof PluginRuntime)[];

export function clearPluginLoaderCache(): void {
  registryCache.clear();
  inFlightPluginRegistryLoads.clear();
  openAllowlistWarningCache.clear();
  clearCompactionProviders();
  clearMemoryEmbeddingProviders();
  clearMemoryPluginState();
}

const defaultLogger = () => createSubsystemLogger("plugins");

function shouldProfilePluginLoader(): boolean {
  return process.env.OPENCLAW_PLUGIN_LOAD_PROFILE === "1";
}

function profilePluginLoaderSync<T>(params: {
  phase: string;
  pluginId?: string;
  source: string;
  run: () => T;
}): T {
  if (!shouldProfilePluginLoader()) {
    return params.run();
  }
  const startMs = performance.now();
  try {
    return params.run();
  } finally {
    const elapsedMs = performance.now() - startMs;
    console.error(
      `[plugin-load-profile] phase=${params.phase} plugin=${params.pluginId ?? "(core)"} elapsedMs=${elapsedMs.toFixed(1)} source=${params.source}`,
    );
  }
}

/**
 * On Windows, the Node.js ESM loader requires absolute paths to be expressed
 * as file:// URLs (e.g. file:///C:/Users/...). Raw drive-letter paths like
 * C:\... are rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME because the loader
 * mistakes the drive letter for an unknown URL scheme.
 *
 * This helper converts Windows absolute import specifiers to file:// URLs and
 * leaves everything else unchanged.
 */
function toSafeImportPath(specifier: string): string {
  if (process.platform !== "win32") {
    return specifier;
  }
  if (specifier.startsWith("file://")) {
    return specifier;
  }
  if (path.win32.isAbsolute(specifier)) {
    const normalizedSpecifier = specifier.replaceAll("\\", "/");
    if (normalizedSpecifier.startsWith("//")) {
      return new URL(`file:${encodeURI(normalizedSpecifier)}`).href;
    }
    return new URL(`file:///${encodeURI(normalizedSpecifier)}`).href;
  }
  return specifier;
}

function createPluginJitiLoader(options: Pick<PluginLoadOptions, "pluginSdkResolution">) {
  const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();
  return (modulePath: string) => {
    const tryNative = shouldPreferNativeJiti(modulePath);
    const aliasMap = buildPluginLoaderAliasMap(
      modulePath,
      process.argv[1],
      import.meta.url,
      options.pluginSdkResolution,
    );
    const cacheKey = JSON.stringify({
      aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
      tryNative,
    });
    const cached = jitiLoaders.get(cacheKey);
    if (cached) {
      return cached;
    }
    const loader = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliasMap),
      // Source .ts runtime shims import sibling ".js" specifiers that only exist
      // After build. Disable native loading for source entries so Jiti rewrites
      // Those imports against the source graph, while keeping native dist/*.js
      // Loading for the canonical built module graph.
      tryNative,
    });
    jitiLoaders.set(cacheKey, loader);
    return loader;
  };
}

export const __testing = {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  getCompatibleActivePluginRegistry,
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  get maxPluginRegistryCacheEntries() {
    return pluginRegistryCacheEntryCap;
  },
  resolveExtensionApiAlias,
  resolvePluginLoadCacheContext,
  resolvePluginRuntimeModulePath,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
  setMaxPluginRegistryCacheEntriesForTest(value?: number) {
    pluginRegistryCacheEntryCap =
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.floor(value))
        : MAX_PLUGIN_REGISTRY_CACHE_ENTRIES;
  },
  shouldLoadChannelPluginInSetupRuntime,
  shouldPreferNativeJiti,
  toSafeImportPath,
};

function getCachedPluginRegistry(cacheKey: string): CachedPluginState | undefined {
  const cached = registryCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  // Refresh insertion order so frequently reused registries survive eviction.
  registryCache.delete(cacheKey);
  registryCache.set(cacheKey, cached);
  return cached;
}

function setCachedPluginRegistry(cacheKey: string, state: CachedPluginState): void {
  if (registryCache.has(cacheKey)) {
    registryCache.delete(cacheKey);
  }
  registryCache.set(cacheKey, state);
  while (registryCache.size > pluginRegistryCacheEntryCap) {
    const oldestKey = registryCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    registryCache.delete(oldestKey);
  }
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  activationMetadataKey?: string;
  installs?: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  preferSetupRuntimeForChannelPlugins?: boolean;
  loadModules?: boolean;
  runtimeSubagentMode?: "default" | "explicit" | "gateway-bindable";
  pluginSdkResolution?: PluginSdkResolutionPreference;
  coreGatewayMethodNames?: string[];
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    env: params.env,
    loadPaths: params.plugins.loadPaths,
    workspaceDir: params.workspaceDir,
  });
  const installs = Object.fromEntries(
    Object.entries(params.installs ?? {}).map(([pluginId, install]) => [
      pluginId,
      {
        ...install,
        installPath:
          typeof install.installPath === "string"
            ? resolveUserPath(install.installPath, params.env)
            : install.installPath,
        sourcePath:
          typeof install.sourcePath === "string"
            ? resolveUserPath(install.sourcePath, params.env)
            : install.sourcePath,
      },
    ]),
  );
  const scopeKey = JSON.stringify(params.onlyPluginIds ?? []);
  const setupOnlyKey = params.includeSetupOnlyChannelPlugins === true ? "setup-only" : "runtime";
  const startupChannelMode =
    params.preferSetupRuntimeForChannelPlugins === true ? "prefer-setup" : "full";
  const moduleLoadMode = params.loadModules === false ? "manifest-only" : "load-modules";
  const runtimeSubagentMode = params.runtimeSubagentMode ?? "default";
  const gatewayMethodsKey = JSON.stringify(params.coreGatewayMethodNames ?? []);
  return `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify({
    ...params.plugins,
    activationMetadataKey: params.activationMetadataKey ?? "",
    installs,
    loadPaths,
  })}::${scopeKey}::${setupOnlyKey}::${startupChannelMode}::${moduleLoadMode}::${runtimeSubagentMode}::${params.pluginSdkResolution ?? "auto"}::${gatewayMethodsKey}`;
}

function normalizeScopedPluginIds(ids?: string[]): string[] | undefined {
  if (!ids) {
    return undefined;
  }
  const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].toSorted();
  return normalized.length > 0 ? normalized : undefined;
}

function matchesScopedPluginRequest(params: {
  onlyPluginIdSet: ReadonlySet<string> | null;
  pluginId: string;
}): boolean {
  const scopedIds = params.onlyPluginIdSet;
  if (!scopedIds) {
    return true;
  }
  return scopedIds.has(params.pluginId);
}

function resolveRuntimeSubagentMode(
  runtimeOptions: PluginLoadOptions["runtimeOptions"],
): "default" | "explicit" | "gateway-bindable" {
  if (runtimeOptions?.allowGatewaySubagentBinding === true) {
    return "gateway-bindable";
  }
  if (runtimeOptions?.subagent) {
    return "explicit";
  }
  return "default";
}

function buildActivationMetadataHash(params: {
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
}): string {
  const enabledSourceChannels = Object.entries(
    (params.activationSource.rootConfig?.channels as Record<string, unknown>) ?? {},
  )
    .filter(([, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      return (value as { enabled?: unknown }).enabled === true;
    })
    .map(([channelId]) => channelId)
    .toSorted((left, right) => left.localeCompare(right));
  const pluginEntryStates = Object.entries(params.activationSource.plugins.entries)
    .map(([pluginId, entry]) => [pluginId, entry?.enabled ?? null] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  const autoEnableReasonEntries = Object.entries(params.autoEnabledReasons)
    .map(([pluginId, reasons]) => [pluginId, [...reasons]] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));

  return createHash("sha256")
    .update(
      JSON.stringify({
        allow: params.activationSource.plugins.allow,
        autoEnabledReasons: autoEnableReasonEntries,
        deny: params.activationSource.plugins.deny,
        enabled: params.activationSource.plugins.enabled,
        enabledChannels: enabledSourceChannels,
        entries: pluginEntryStates,
        memorySlot: params.activationSource.plugins.slots.memory,
      }),
    )
    .digest("hex");
}

function hasExplicitCompatibilityInputs(options: PluginLoadOptions): boolean {
  return Boolean(
    options.config !== undefined ||
    options.activationSourceConfig !== undefined ||
    options.autoEnabledReasons !== undefined ||
    options.workspaceDir !== undefined ||
    options.env !== undefined ||
    options.onlyPluginIds?.length ||
    options.runtimeOptions !== undefined ||
    options.pluginSdkResolution !== undefined ||
    options.coreGatewayHandlers !== undefined ||
    options.includeSetupOnlyChannelPlugins === true ||
    options.preferSetupRuntimeForChannelPlugins === true ||
    options.loadModules === false,
  );
}

function resolvePluginLoadCacheContext(options: PluginLoadOptions = {}) {
  const env = options.env ?? process.env;
  const cfg = applyTestPluginDefaults(options.config ?? {}, env);
  const activationSourceConfig = options.activationSourceConfig ?? options.config ?? {};
  const normalized = normalizePluginsConfig(cfg.plugins);
  const activationSource = createPluginActivationSource({
    config: activationSourceConfig,
  });
  const onlyPluginIds = normalizeScopedPluginIds(options.onlyPluginIds);
  const includeSetupOnlyChannelPlugins = options.includeSetupOnlyChannelPlugins === true;
  const preferSetupRuntimeForChannelPlugins = options.preferSetupRuntimeForChannelPlugins === true;
  const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
  const coreGatewayMethodNames = Object.keys(options.coreGatewayHandlers ?? {}).toSorted();
  const cacheKey = buildCacheKey({
    activationMetadataKey: buildActivationMetadataHash({
      activationSource,
      autoEnabledReasons: options.autoEnabledReasons ?? {},
    }),
    coreGatewayMethodNames,
    env,
    includeSetupOnlyChannelPlugins,
    installs: cfg.plugins?.installs,
    loadModules: options.loadModules,
    onlyPluginIds,
    pluginSdkResolution: options.pluginSdkResolution,
    plugins: normalized,
    preferSetupRuntimeForChannelPlugins,
    runtimeSubagentMode,
    workspaceDir: options.workspaceDir,
  });
  return {
    activationSource,
    activationSourceConfig,
    autoEnabledReasons: options.autoEnabledReasons ?? {},
    cacheKey,
    cfg,
    env,
    includeSetupOnlyChannelPlugins,
    normalized,
    onlyPluginIds,
    preferSetupRuntimeForChannelPlugins,
    runtimeSubagentMode,
    shouldActivate: options.activate !== false,
    shouldLoadModules: options.loadModules !== false,
  };
}

function getCompatibleActivePluginRegistry(
  options: PluginLoadOptions = {},
): PluginRegistry | undefined {
  const activeRegistry = getActivePluginRegistry() ?? undefined;
  if (!activeRegistry) {
    return undefined;
  }
  if (!hasExplicitCompatibilityInputs(options)) {
    return activeRegistry;
  }
  const activeCacheKey = getActivePluginRegistryKey();
  if (!activeCacheKey) {
    return undefined;
  }
  const loadContext = resolvePluginLoadCacheContext(options);
  if (loadContext.cacheKey === activeCacheKey) {
    return activeRegistry;
  }
  if (
    loadContext.runtimeSubagentMode === "default" &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable"
  ) {
    const gatewayBindableCacheKey = resolvePluginLoadCacheContext({
      ...options,
      runtimeOptions: {
        ...options.runtimeOptions,
        allowGatewaySubagentBinding: true,
      },
    }).cacheKey;
    if (gatewayBindableCacheKey === activeCacheKey) {
      return activeRegistry;
    }
  }
  return undefined;
}

export function resolveRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  if (!options || !hasExplicitCompatibilityInputs(options)) {
    return getCompatibleActivePluginRegistry();
  }
  const compatible = getCompatibleActivePluginRegistry(options);
  if (compatible) {
    return compatible;
  }
  // Helper/runtime callers should not recurse into the same snapshot load while
  // Plugin registration is still in flight. Let direct loadOpenClawPlugins(...)
  // Callers surface the hard error instead.
  if (isPluginRegistryLoadInFlight(options)) {
    return undefined;
  }
  return loadOpenClawPlugins(options);
}

export function resolvePluginRegistryLoadCacheKey(options: PluginLoadOptions = {}): string {
  return resolvePluginLoadCacheContext(options).cacheKey;
}

export function isPluginRegistryLoadInFlight(options: PluginLoadOptions = {}): boolean {
  return inFlightPluginRegistryLoads.has(resolvePluginRegistryLoadCacheKey(options));
}

export function resolveCompatibleRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  // Check whether the active runtime registry is already compatible with these
  // Load options. Unlike resolveRuntimePluginRegistry, this never triggers a
  // Fresh plugin load on cache miss.
  return getCompatibleActivePluginRegistry(options);
}

function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const {schema} = params;
  if (!schema) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  const cacheKey = params.cacheKey ?? JSON.stringify(schema);
  const result = validateJsonSchemaValue({
    applyDefaults: true,
    cacheKey,
    schema,
    value: params.value ?? {},
  });
  if (result.ok) {
    return { ok: true, value: result.value as Record<string, unknown> | undefined };
  }
  return { errors: result.errors.map((error) => error.text), ok: false };
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as OpenClawPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function resolveSetupChannelRegistration(moduleExport: unknown): {
  plugin?: ChannelPlugin;
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (!resolved || typeof resolved !== "object") {
    return {};
  }
  const setup = resolved as {
    plugin?: unknown;
  };
  if (!setup.plugin || typeof setup.plugin !== "object") {
    return {};
  }
  return {
    plugin: setup.plugin as ChannelPlugin,
  };
}

function shouldLoadChannelPluginInSetupRuntime(params: {
  manifestChannels: string[];
  setupSource?: string;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  preferSetupRuntimeForChannelPlugins?: boolean;
}): boolean {
  if (!params.setupSource || params.manifestChannels.length === 0) {
    return false;
  }
  if (
    params.preferSetupRuntimeForChannelPlugins &&
    params.startupDeferConfiguredChannelFullLoadUntilAfterListen === true
  ) {
    return true;
  }
  return !params.manifestChannels.some((channelId) =>
    isChannelConfigured(params.cfg, channelId, params.env),
  );
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  source: string;
  rootDir?: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  activationState?: PluginActivationState;
  configSchema: boolean;
  contracts?: PluginManifestContracts;
}): PluginRecord {
  return {
    activated: params.activationState?.activated,
    activationReason: params.activationState?.reason,
    activationSource: params.activationState?.source,
    bundleCapabilities: params.bundleCapabilities,
    bundleFormat: params.bundleFormat,
    channelIds: [],
    cliBackendIds: [],
    cliCommands: [],
    commands: [],
    configJsonSchema: undefined,
    configSchema: params.configSchema,
    configUiHints: undefined,
    contracts: params.contracts,
    description: params.description,
    enabled: params.enabled,
    explicitlyEnabled: params.activationState?.explicitlyEnabled,
    format: params.format ?? "openclaw",
    gatewayMethods: [],
    hookCount: 0,
    hookNames: [],
    httpRoutes: 0,
    id: params.id,
    imageGenerationProviderIds: [],
    mediaUnderstandingProviderIds: [],
    memoryEmbeddingProviderIds: [],
    musicGenerationProviderIds: [],
    name: params.name ?? params.id,
    origin: params.origin,
    providerIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    rootDir: params.rootDir,
    services: [],
    source: params.source,
    speechProviderIds: [],
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    version: params.version,
    videoGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    workspaceDir: params.workspaceDir,
  };
}

function markPluginActivationDisabled(record: PluginRecord, reason?: string): void {
  record.activated = false;
  record.activationSource = "disabled";
  record.activationReason = reason;
}

function formatAutoEnabledActivationReason(
  reasons: readonly string[] | undefined,
): string | undefined {
  if (!reasons || reasons.length === 0) {
    return undefined;
  }
  return reasons.join("; ");
}

function recordPluginError(params: {
  logger: PluginLogger;
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  phase: PluginRecord["failurePhase"];
  error: unknown;
  logPrefix: string;
  diagnosticMessagePrefix: string;
}) {
  const errorText =
    process.env.OPENCLAW_PLUGIN_LOADER_DEBUG_STACKS === "1" &&
    params.error instanceof Error &&
    typeof params.error.stack === "string"
      ? params.error.stack
      : String(params.error);
  const deprecatedApiHint =
    errorText.includes("api.registerHttpHandler") && errorText.includes("is not a function")
      ? "deprecated api.registerHttpHandler(...) was removed; use api.registerHttpRoute(...) for plugin-owned routes or registerPluginHttpRoute(...) for dynamic lifecycle routes"
      : null;
  const displayError = deprecatedApiHint ? `${deprecatedApiHint} (${errorText})` : errorText;
  params.logger.error(`${params.logPrefix}${displayError}`);
  params.record.status = "error";
  params.record.error = displayError;
  params.record.failedAt = new Date();
  params.record.failurePhase = params.phase;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    message: `${params.diagnosticMessagePrefix}${displayError}`,
    pluginId: params.record.id,
    source: params.record.source,
  });
}

function formatPluginFailureSummary(failedPlugins: PluginRecord[]): string {
  const grouped = new Map<NonNullable<PluginRecord["failurePhase"]>, string[]>();
  for (const plugin of failedPlugins) {
    const phase = plugin.failurePhase ?? "load";
    const ids = grouped.get(phase);
    if (ids) {
      ids.push(plugin.id);
      continue;
    }
    grouped.set(phase, [plugin.id]);
  }
  return [...grouped.entries()].map(([phase, ids]) => `${phase}: ${ids.join(", ")}`).join("; ");
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

function maybeThrowOnPluginLoadError(
  registry: PluginRegistry,
  throwOnLoadError: boolean | undefined,
): void {
  if (!throwOnLoadError) {
    return;
  }
  if (!registry.plugins.some((entry) => entry.status === "error")) {
    return;
  }
  throw new PluginLoadFailureError(registry);
}

interface PathMatcher {
  exact: Set<string>;
  dirs: string[];
}

interface InstallTrackingRule {
  trackedWithoutPaths: boolean;
  matcher: PathMatcher;
}

interface PluginProvenanceIndex {
  loadPathMatcher: PathMatcher;
  installRules: Map<string, InstallTrackingRule>;
}

function createPathMatcher(): PathMatcher {
  return { dirs: [], exact: new Set<string>() };
}

function addPathToMatcher(
  matcher: PathMatcher,
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return;
  }
  const resolved = resolveUserPath(trimmed, env);
  if (!resolved) {
    return;
  }
  if (matcher.exact.has(resolved) || matcher.dirs.includes(resolved)) {
    return;
  }
  const stat = safeStatSync(resolved);
  if (stat?.isDirectory()) {
    matcher.dirs.push(resolved);
    return;
  }
  matcher.exact.add(resolved);
}

function matchesPathMatcher(matcher: PathMatcher, sourcePath: string): boolean {
  if (matcher.exact.has(sourcePath)) {
    return true;
  }
  return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}

function buildProvenanceIndex(params: {
  config: OpenClawConfig;
  normalizedLoadPaths: string[];
  env: NodeJS.ProcessEnv;
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath, params.env);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs = params.config.plugins?.installs ?? {};
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      matcher: createPathMatcher(),
      trackedWithoutPaths: false,
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath, params.env);
      }
    }
    installRules.set(pluginId, rule);
  }

  return { installRules, loadPathMatcher };
}

function isTrackedByProvenance(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const installRule = params.index.installRules.get(params.pluginId);
  if (installRule) {
    if (installRule.trackedWithoutPaths) {
      return true;
    }
    if (matchesPathMatcher(installRule.matcher, sourcePath)) {
      return true;
    }
  }
  return matchesPathMatcher(params.index.loadPathMatcher, sourcePath);
}

function matchesExplicitInstallRule(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const installRule = params.index.installRules.get(params.pluginId);
  if (!installRule || installRule.trackedWithoutPaths) {
    return false;
  }
  return matchesPathMatcher(installRule.matcher, sourcePath);
}

function resolveCandidateDuplicateRank(params: {
  candidate: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  manifestByRoot: Map<string, ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const manifestRecord = params.manifestByRoot.get(params.candidate.rootDir);
  const pluginId = manifestRecord?.id;
  const isExplicitInstall =
    params.candidate.origin === "global" &&
    pluginId !== undefined &&
    matchesExplicitInstallRule({
      env: params.env,
      index: params.provenance,
      pluginId,
      source: params.candidate.source,
    });

  if (params.candidate.origin === "config") {
    return 0;
  }
  if (params.candidate.origin === "global" && isExplicitInstall) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids stay reserved unless the operator configured an override.
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

function compareDuplicateCandidateOrder(params: {
  left: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  right: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  manifestByRoot: Map<string, ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const leftPluginId = params.manifestByRoot.get(params.left.rootDir)?.id;
  const rightPluginId = params.manifestByRoot.get(params.right.rootDir)?.id;
  if (!leftPluginId || leftPluginId !== rightPluginId) {
    return 0;
  }
  return (
    resolveCandidateDuplicateRank({
      candidate: params.left,
      env: params.env,
      manifestByRoot: params.manifestByRoot,
      provenance: params.provenance,
    }) -
    resolveCandidateDuplicateRank({
      candidate: params.right,
      env: params.env,
      manifestByRoot: params.manifestByRoot,
      provenance: params.provenance,
    })
  );
}

function warnWhenAllowlistIsOpen(params: {
  emitWarning: boolean;
  logger: PluginLogger;
  pluginsEnabled: boolean;
  allow: string[];
  warningCacheKey: string;
  discoverablePlugins: { id: string; source: string; origin: PluginRecord["origin"] }[];
}) {
  if (!params.emitWarning) {
    return;
  }
  if (!params.pluginsEnabled) {
    return;
  }
  if (params.allow.length > 0) {
    return;
  }
  const autoDiscoverable = params.discoverablePlugins.filter(
    (entry) => entry.origin === "workspace" || entry.origin === "global",
  );
  if (autoDiscoverable.length === 0) {
    return;
  }
  if (openAllowlistWarningCache.has(params.warningCacheKey)) {
    return;
  }
  const preview = autoDiscoverable
    .slice(0, 6)
    .map((entry) => `${entry.id} (${entry.source})`)
    .join(", ");
  const extra = autoDiscoverable.length > 6 ? ` (+${autoDiscoverable.length - 6} more)` : "";
  openAllowlistWarningCache.add(params.warningCacheKey);
  params.logger.warn(
    `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`,
  );
}

function warnAboutUntrackedLoadedPlugins(params: {
  registry: PluginRegistry;
  provenance: PluginProvenanceIndex;
  allowlist: string[];
  emitWarning: boolean;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
}) {
  const allowSet = new Set(params.allowlist);
  for (const plugin of params.registry.plugins) {
    if (plugin.status !== "loaded" || plugin.origin === "bundled") {
      continue;
    }
    if (allowSet.has(plugin.id)) {
      continue;
    }
    if (
      isTrackedByProvenance({
        env: params.env,
        index: params.provenance,
        pluginId: plugin.id,
        source: plugin.source,
      })
    ) {
      continue;
    }
    const message =
      "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
    params.registry.diagnostics.push({
      level: "warn",
      message,
      pluginId: plugin.id,
      source: plugin.source,
    });
    if (params.emitWarning) {
      params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
    }
  }
}

function activatePluginRegistry(
  registry: PluginRegistry,
  cacheKey: string,
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable",
  workspaceDir?: string,
): void {
  setActivePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir);
  initializeGlobalHookRunner(registry);
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  // Snapshot (non-activating) loads must disable the cache to avoid storing a registry
  // Whose commands were never globally registered.
  if (options.activate === false && options.cache !== false) {
    throw new Error(
      "loadOpenClawPlugins: activate:false requires cache:false to prevent command registry divergence",
    );
  }
  const {
    env,
    cfg,
    normalized,
    activationSource,
    autoEnabledReasons,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    preferSetupRuntimeForChannelPlugins,
    shouldActivate,
    shouldLoadModules,
    cacheKey,
    runtimeSubagentMode,
  } = resolvePluginLoadCacheContext(options);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const onlyPluginIdSet = onlyPluginIds ? new Set(onlyPluginIds) : null;
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = getCachedPluginRegistry(cacheKey);
    if (cached) {
      restoreRegisteredCompactionProviders(cached.compactionProviders);
      restoreRegisteredMemoryEmbeddingProviders(cached.memoryEmbeddingProviders);
      restoreMemoryPluginState({
        corpusSupplements: cached.memoryCorpusSupplements,
        flushPlanResolver: cached.memoryFlushPlanResolver,
        promptBuilder: cached.memoryPromptBuilder,
        promptSupplements: cached.memoryPromptSupplements,
        runtime: cached.memoryRuntime,
      });
      if (shouldActivate) {
        activatePluginRegistry(
          cached.registry,
          cacheKey,
          runtimeSubagentMode,
          options.workspaceDir,
        );
      }
      return cached.registry;
    }
  }
  if (inFlightPluginRegistryLoads.has(cacheKey)) {
    throw new PluginLoadReentryError(cacheKey);
  }
  inFlightPluginRegistryLoads.add(cacheKey);
  try {
    // Clear previously registered plugin state before reloading.
    // Skip for non-activating (snapshot) loads to avoid wiping commands from other plugins.
    if (shouldActivate) {
      clearPluginCommands();
      clearPluginInteractiveHandlers();
      clearMemoryPluginState();
    }

    // Lazy: avoid creating the Jiti loader when all plugins are disabled (common in unit tests).
    const getJiti = createPluginJitiLoader(options);

    let createPluginRuntimeFactory:
      | ((options?: CreatePluginRuntimeOptions) => PluginRuntime)
      | null = null;
    const resolveCreatePluginRuntime = (): ((
      options?: CreatePluginRuntimeOptions,
    ) => PluginRuntime) => {
      if (createPluginRuntimeFactory) {
        return createPluginRuntimeFactory;
      }
      const runtimeModulePath = resolvePluginRuntimeModulePath({
        pluginSdkResolution: options.pluginSdkResolution,
      });
      if (!runtimeModulePath) {
        throw new Error("Unable to resolve plugin runtime module");
      }
      const safeRuntimePath = toSafeImportPath(runtimeModulePath);
      const runtimeModule = profilePluginLoaderSync({
        phase: "runtime-module",
        run: () =>
          getJiti(runtimeModulePath)(safeRuntimePath) as {
            createPluginRuntime?: (options?: CreatePluginRuntimeOptions) => PluginRuntime;
          },
        source: runtimeModulePath,
      });
      if (typeof runtimeModule.createPluginRuntime !== "function") {
        throw new Error("Plugin runtime module missing createPluginRuntime export");
      }
      createPluginRuntimeFactory = runtimeModule.createPluginRuntime;
      return createPluginRuntimeFactory;
    };

    // Lazily initialize the runtime so startup paths that discover/skip plugins do
    // Not eagerly load every channel/runtime dependency tree.
    let resolvedRuntime: PluginRuntime | null = null;
    const resolveRuntime = (): PluginRuntime => {
      resolvedRuntime ??= resolveCreatePluginRuntime()(options.runtimeOptions);
      return resolvedRuntime;
    };
    const lazyRuntimeReflectionKeySet = new Set<PropertyKey>(LAZY_RUNTIME_REFLECTION_KEYS);
    const resolveLazyRuntimeDescriptor = (prop: PropertyKey): PropertyDescriptor | undefined => {
      if (!lazyRuntimeReflectionKeySet.has(prop)) {
        return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
      }
      return {
        configurable: true,
        enumerable: true,
        get() {
          return Reflect.get(resolveRuntime() as object, prop);
        },
        set(value: unknown) {
          Reflect.set(resolveRuntime() as object, prop, value);
        },
      };
    };
    const runtime = new Proxy({} as PluginRuntime, {
      defineProperty(_target, prop, attributes) {
        return Reflect.defineProperty(resolveRuntime() as object, prop, attributes);
      },
      deleteProperty(_target, prop) {
        return Reflect.deleteProperty(resolveRuntime() as object, prop);
      },
      get(_target, prop, receiver) {
        return Reflect.get(resolveRuntime(), prop, receiver);
      },
      getOwnPropertyDescriptor(_target, prop) {
        return resolveLazyRuntimeDescriptor(prop);
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(resolveRuntime() as object);
      },
      has(_target, prop) {
        return lazyRuntimeReflectionKeySet.has(prop) || Reflect.has(resolveRuntime(), prop);
      },
      ownKeys() {
        return [...LAZY_RUNTIME_REFLECTION_KEYS];
      },
      set(_target, prop, value, receiver) {
        return Reflect.set(resolveRuntime(), prop, value, receiver);
      },
    });

    const {
      registry,
      createApi,
      registerReload,
      registerNodeHostCommand,
      registerSecurityAuditCollector,
    } = createPluginRegistry({
      activateGlobalSideEffects: shouldActivate,
      coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
      logger,
      runtime,
    });

    const discovery = discoverOpenClawPlugins({
      cache: options.cache,
      env,
      extraPaths: normalized.loadPaths,
      workspaceDir: options.workspaceDir,
    });
    const manifestRegistry = loadPluginManifestRegistry({
      cache: options.cache,
      candidates: discovery.candidates,
      config: cfg,
      diagnostics: discovery.diagnostics,
      env,
      workspaceDir: options.workspaceDir,
    });
    pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
    warnWhenAllowlistIsOpen({
      emitWarning: shouldActivate,
      logger,
      pluginsEnabled: normalized.enabled,
      allow: normalized.allow,
      warningCacheKey: cacheKey,
      // Keep warning input scoped as well so partial snapshot loads only mention the
      // Plugins that were intentionally requested for this registry.
      discoverablePlugins: manifestRegistry.plugins
        .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
        .map((plugin) => ({
          id: plugin.id,
          origin: plugin.origin,
          source: plugin.source,
        })),
    });
    const provenance = buildProvenanceIndex({
      config: cfg,
      env,
      normalizedLoadPaths: normalized.loadPaths,
    });

    const manifestByRoot = new Map(
      manifestRegistry.plugins.map((record) => [record.rootDir, record]),
    );
    const orderedCandidates = [...discovery.candidates].toSorted((left, right) => compareDuplicateCandidateOrder({
        env,
        left,
        manifestByRoot,
        provenance,
        right,
      }));

    const seenIds = new Map<string, PluginRecord["origin"]>();
    const memorySlot = normalized.slots.memory;
    let selectedMemoryPluginId: string | null = null;
    let memorySlotMatched = false;

    for (const candidate of orderedCandidates) {
      const manifestRecord = manifestByRoot.get(candidate.rootDir);
      if (!manifestRecord) {
        continue;
      }
      const pluginId = manifestRecord.id;
      const matchesRequestedScope = matchesScopedPluginRequest({
        onlyPluginIdSet,
        pluginId,
      });
      // Filter again at import time as a final guard. The earlier manifest filter keeps
      // Warnings scoped; this one prevents loading/registering anything outside the scope.
      if (!matchesRequestedScope) {
        continue;
      }
      const activationState = resolveEffectivePluginActivationState({
        activationSource,
        autoEnabledReason: formatAutoEnabledActivationReason(autoEnabledReasons[pluginId]),
        config: normalized,
        enabledByDefault: manifestRecord.enabledByDefault,
        id: pluginId,
        origin: candidate.origin,
        rootConfig: cfg,
      });
      const existingOrigin = seenIds.get(pluginId);
      if (existingOrigin) {
        const record = createPluginRecord({
          activationState,
          bundleCapabilities: manifestRecord.bundleCapabilities,
          bundleFormat: manifestRecord.bundleFormat,
          configSchema: Boolean(manifestRecord.configSchema),
          contracts: manifestRecord.contracts,
          description: manifestRecord.description,
          enabled: false,
          format: manifestRecord.format,
          id: pluginId,
          name: manifestRecord.name ?? pluginId,
          origin: candidate.origin,
          rootDir: candidate.rootDir,
          source: candidate.source,
          version: manifestRecord.version,
          workspaceDir: candidate.workspaceDir,
        });
        record.status = "disabled";
        record.error = `overridden by ${existingOrigin} plugin`;
        markPluginActivationDisabled(record, record.error);
        registry.plugins.push(record);
        continue;
      }

      const enableState = resolveEffectiveEnableState({
        activationSource,
        config: normalized,
        enabledByDefault: manifestRecord.enabledByDefault,
        id: pluginId,
        origin: candidate.origin,
        rootConfig: cfg,
      });
      const entry = normalized.entries[pluginId];
      const record = createPluginRecord({
        activationState,
        bundleCapabilities: manifestRecord.bundleCapabilities,
        bundleFormat: manifestRecord.bundleFormat,
        configSchema: Boolean(manifestRecord.configSchema),
        contracts: manifestRecord.contracts,
        description: manifestRecord.description,
        enabled: enableState.enabled,
        format: manifestRecord.format,
        id: pluginId,
        name: manifestRecord.name ?? pluginId,
        origin: candidate.origin,
        rootDir: candidate.rootDir,
        source: candidate.source,
        version: manifestRecord.version,
        workspaceDir: candidate.workspaceDir,
      });
      record.kind = manifestRecord.kind;
      record.configUiHints = manifestRecord.configUiHints;
      record.configJsonSchema = manifestRecord.configSchema;
      const pushPluginLoadError = (message: string) => {
        record.status = "error";
        record.error = message;
        record.failedAt = new Date();
        record.failurePhase = "validation";
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        registry.diagnostics.push({
          level: "error",
          message: record.error,
          pluginId: record.id,
          source: record.source,
        });
      };

      const registrationMode = enableState.enabled
        ? (!validateOnly &&
          shouldLoadChannelPluginInSetupRuntime({
            cfg,
            env,
            manifestChannels: manifestRecord.channels,
            preferSetupRuntimeForChannelPlugins,
            setupSource: manifestRecord.setupSource,
            startupDeferConfiguredChannelFullLoadUntilAfterListen:
              manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
          })
          ? "setup-runtime"
          : "full")
        : (includeSetupOnlyChannelPlugins &&
            !validateOnly &&
            onlyPluginIdSet &&
            manifestRecord.channels.length > 0
          ? "setup-only"
          : null);

      if (!registrationMode) {
        record.status = "disabled";
        record.error = enableState.reason;
        markPluginActivationDisabled(record, enableState.reason);
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
      if (!enableState.enabled) {
        record.status = "disabled";
        record.error = enableState.reason;
        markPluginActivationDisabled(record, enableState.reason);
      }

      if (record.format === "bundle") {
        const unsupportedCapabilities = (record.bundleCapabilities ?? []).filter(
          (capability) =>
            capability !== "skills" &&
            capability !== "mcpServers" &&
            capability !== "settings" &&
            !(
              (capability === "commands" ||
                capability === "agents" ||
                capability === "outputStyles" ||
                capability === "lspServers") &&
              (record.bundleFormat === "claude" || record.bundleFormat === "cursor")
            ) &&
            !(
              capability === "hooks" &&
              (record.bundleFormat === "codex" || record.bundleFormat === "claude")
            ),
        );
        for (const capability of unsupportedCapabilities) {
          registry.diagnostics.push({
            level: "warn",
            message: `bundle capability detected but not wired into OpenClaw yet: ${capability}`,
            pluginId: record.id,
            source: record.source,
          });
        }
        if (
          enableState.enabled &&
          record.rootDir &&
          record.bundleFormat &&
          (record.bundleCapabilities ?? []).includes("mcpServers")
        ) {
          const runtimeSupport = inspectBundleMcpRuntimeSupport({
            bundleFormat: record.bundleFormat,
            pluginId: record.id,
            rootDir: record.rootDir,
          });
          for (const message of runtimeSupport.diagnostics) {
            registry.diagnostics.push({
              level: "warn",
              message,
              pluginId: record.id,
              source: record.source,
            });
          }
          if (runtimeSupport.unsupportedServerNames.length > 0) {
            registry.diagnostics.push({
              level: "warn",
              message:
                "bundle MCP servers use unsupported transports or incomplete configs " +
                `(stdio only today): ${runtimeSupport.unsupportedServerNames.join(", ")}`,
              pluginId: record.id,
              source: record.source,
            });
          }
        }
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
      // Fast-path bundled memory plugins that are guaranteed disabled by slot policy.
      // This avoids opening/importing heavy memory plugin modules that will never register.
      if (
        registrationMode === "full" &&
        candidate.origin === "bundled" &&
        hasKind(manifestRecord.kind, "memory")
      ) {
        const earlyMemoryDecision = resolveMemorySlotDecision({
          id: record.id,
          kind: manifestRecord.kind,
          selectedId: selectedMemoryPluginId,
          slot: memorySlot,
        });
        if (!earlyMemoryDecision.enabled) {
          record.enabled = false;
          record.status = "disabled";
          record.error = earlyMemoryDecision.reason;
          markPluginActivationDisabled(record, earlyMemoryDecision.reason);
          registry.plugins.push(record);
          seenIds.set(pluginId, candidate.origin);
          continue;
        }
      }

      if (!manifestRecord.configSchema) {
        pushPluginLoadError("missing config schema");
        continue;
      }

      if (!shouldLoadModules && registrationMode === "full") {
        const memoryDecision = resolveMemorySlotDecision({
          id: record.id,
          kind: record.kind,
          selectedId: selectedMemoryPluginId,
          slot: memorySlot,
        });

        if (!memoryDecision.enabled) {
          record.enabled = false;
          record.status = "disabled";
          record.error = memoryDecision.reason;
          markPluginActivationDisabled(record, memoryDecision.reason);
          registry.plugins.push(record);
          seenIds.set(pluginId, candidate.origin);
          continue;
        }

        if (memoryDecision.selected && hasKind(record.kind, "memory")) {
          selectedMemoryPluginId = record.id;
          memorySlotMatched = true;
          record.memorySlotSelected = true;
        }
      }

      const validatedConfig = validatePluginConfig({
        cacheKey: manifestRecord.schemaCacheKey,
        schema: manifestRecord.configSchema,
        value: entry?.config,
      });

      if (!validatedConfig.ok) {
        logger.error(
          `[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`,
        );
        pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
        continue;
      }

      if (!shouldLoadModules) {
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }

      const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
      const loadSource =
        (registrationMode === "setup-only" || registrationMode === "setup-runtime") &&
        manifestRecord.setupSource
          ? manifestRecord.setupSource
          : candidate.source;
      const opened = openBoundaryFileSync({
        absolutePath: loadSource,
        boundaryLabel: "plugin root",
        rejectHardlinks: candidate.origin !== "bundled",
        rootPath: pluginRoot,
        skipLexicalRootCheck: true,
      });
      if (!opened.ok) {
        pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
        continue;
      }
      const safeSource = opened.path;
      fs.closeSync(opened.fd);
      const safeImportSource = toSafeImportPath(safeSource);

      let mod: OpenClawPluginModule | null = null;
      try {
        // Track the plugin as imported once module evaluation begins. Top-level
        // Code may have already executed even if evaluation later throws.
        recordImportedPluginId(record.id);
        mod = profilePluginLoaderSync({
          phase: registrationMode,
          pluginId: record.id,
          run: () => getJiti(safeSource)(safeImportSource) as OpenClawPluginModule,
          source: safeSource,
        });
      } catch (error) {
        recordPluginError({
          diagnosticMessagePrefix: "failed to load plugin: ",
          error: error,
          logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
          logger,
          origin: candidate.origin,
          phase: "load",
          pluginId,
          record,
          registry,
          seenIds,
        });
        continue;
      }

      if (
        (registrationMode === "setup-only" || registrationMode === "setup-runtime") &&
        manifestRecord.setupSource
      ) {
        const setupRegistration = resolveSetupChannelRegistration(mod);
        if (setupRegistration.plugin) {
          if (setupRegistration.plugin.id && setupRegistration.plugin.id !== record.id) {
            pushPluginLoadError(
              `plugin id mismatch (config uses "${record.id}", setup export uses "${setupRegistration.plugin.id}")`,
            );
            continue;
          }
          const api = createApi(record, {
            config: cfg,
            hookPolicy: entry?.hooks,
            pluginConfig: {},
            registrationMode,
          });
          api.registerChannel(setupRegistration.plugin);
          registry.plugins.push(record);
          seenIds.set(pluginId, candidate.origin);
          continue;
        }
      }

      const resolved = resolvePluginModuleExport(mod);
      const {definition} = resolved;
      const {register} = resolved;

      if (definition?.id && definition.id !== record.id) {
        pushPluginLoadError(
          `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
        );
        continue;
      }

      record.name = definition?.name ?? record.name;
      record.description = definition?.description ?? record.description;
      record.version = definition?.version ?? record.version;
      const manifestKind = record.kind;
      const exportKind = definition?.kind;
      if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) {
        registry.diagnostics.push({
          level: "warn",
          message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`,
          pluginId: record.id,
          source: record.source,
        });
      }
      record.kind = definition?.kind ?? record.kind;

      if (hasKind(record.kind, "memory") && memorySlot === record.id) {
        memorySlotMatched = true;
      }

      if (registrationMode === "full") {
        const memoryDecision = resolveMemorySlotDecision({
          id: record.id,
          kind: record.kind,
          selectedId: selectedMemoryPluginId,
          slot: memorySlot,
        });

        if (!memoryDecision.enabled) {
          record.enabled = false;
          record.status = "disabled";
          record.error = memoryDecision.reason;
          markPluginActivationDisabled(record, memoryDecision.reason);
          registry.plugins.push(record);
          seenIds.set(pluginId, candidate.origin);
          continue;
        }

        if (memoryDecision.selected && hasKind(record.kind, "memory")) {
          selectedMemoryPluginId = record.id;
          record.memorySlotSelected = true;
        }
      }

      if (registrationMode === "full") {
        if (definition?.reload) {
          registerReload(record, definition.reload);
        }
        for (const nodeHostCommand of definition?.nodeHostCommands ?? []) {
          registerNodeHostCommand(record, nodeHostCommand);
        }
        for (const collector of definition?.securityAuditCollectors ?? []) {
          registerSecurityAuditCollector(record, collector);
        }
      }

      if (validateOnly) {
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }

      if (typeof register !== "function") {
        logger.error(`[plugins] ${record.id} missing register/activate export`);
        pushPluginLoadError("plugin export missing register/activate");
        continue;
      }

      const api = createApi(record, {
        config: cfg,
        hookPolicy: entry?.hooks,
        pluginConfig: validatedConfig.value,
        registrationMode,
      });
      const previousCompactionProviders = listRegisteredCompactionProviders();
      const previousMemoryEmbeddingProviders = listRegisteredMemoryEmbeddingProviders();
      const previousMemoryFlushPlanResolver = getMemoryFlushPlanResolver();
      const previousMemoryPromptBuilder = getMemoryPromptSectionBuilder();
      const previousMemoryCorpusSupplements = listMemoryCorpusSupplements();
      const previousMemoryPromptSupplements = listMemoryPromptSupplements();
      const previousMemoryRuntime = getMemoryRuntime();

      try {
        const result = register(api);
        if (result && typeof result.then === "function") {
          registry.diagnostics.push({
            level: "warn",
            message: "plugin register returned a promise; async registration is ignored",
            pluginId: record.id,
            source: record.source,
          });
        }
        // Snapshot loads should not replace process-global runtime prompt state.
        if (!shouldActivate) {
          restoreRegisteredCompactionProviders(previousCompactionProviders);
          restoreRegisteredMemoryEmbeddingProviders(previousMemoryEmbeddingProviders);
          restoreMemoryPluginState({
            corpusSupplements: previousMemoryCorpusSupplements,
            flushPlanResolver: previousMemoryFlushPlanResolver,
            promptBuilder: previousMemoryPromptBuilder,
            promptSupplements: previousMemoryPromptSupplements,
            runtime: previousMemoryRuntime,
          });
        }
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
      } catch (error) {
        restoreRegisteredCompactionProviders(previousCompactionProviders);
        restoreRegisteredMemoryEmbeddingProviders(previousMemoryEmbeddingProviders);
        restoreMemoryPluginState({
          corpusSupplements: previousMemoryCorpusSupplements,
          flushPlanResolver: previousMemoryFlushPlanResolver,
          promptBuilder: previousMemoryPromptBuilder,
          promptSupplements: previousMemoryPromptSupplements,
          runtime: previousMemoryRuntime,
        });
        recordPluginError({
          diagnosticMessagePrefix: "plugin failed during register: ",
          error: error,
          logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
          logger,
          origin: candidate.origin,
          phase: "register",
          pluginId,
          record,
          registry,
          seenIds,
        });
      }
    }

    // Scoped snapshot loads may intentionally omit the configured memory plugin, so only
    // Emit the missing-memory diagnostic for full registry loads.
    if (!onlyPluginIdSet && typeof memorySlot === "string" && !memorySlotMatched) {
      registry.diagnostics.push({
        level: "warn",
        message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
      });
    }

    warnAboutUntrackedLoadedPlugins({
      allowlist: normalized.allow,
      emitWarning: shouldActivate,
      env,
      logger,
      provenance,
      registry,
    });

    maybeThrowOnPluginLoadError(registry, options.throwOnLoadError);

    if (shouldActivate && options.mode !== "validate") {
      const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
      if (failedPlugins.length > 0) {
        logger.warn(
          `[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(
            failedPlugins,
          )}). Run 'openclaw plugins list' for details.`,
        );
      }
    }

    if (cacheEnabled) {
      setCachedPluginRegistry(cacheKey, {
        compactionProviders: listRegisteredCompactionProviders(),
        memoryCorpusSupplements: listMemoryCorpusSupplements(),
        memoryEmbeddingProviders: listRegisteredMemoryEmbeddingProviders(),
        memoryFlushPlanResolver: getMemoryFlushPlanResolver(),
        memoryPromptBuilder: getMemoryPromptSectionBuilder(),
        memoryPromptSupplements: listMemoryPromptSupplements(),
        memoryRuntime: getMemoryRuntime(),
        registry,
      });
    }
    if (shouldActivate) {
      activatePluginRegistry(registry, cacheKey, runtimeSubagentMode, options.workspaceDir);
    }
    return registry;
  } finally {
    inFlightPluginRegistryLoads.delete(cacheKey);
  }
}

export async function loadOpenClawPluginCliRegistry(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const { env, cfg, normalized, activationSource, autoEnabledReasons, onlyPluginIds, cacheKey } =
    resolvePluginLoadCacheContext({
      ...options,
      activate: false,
      cache: false,
    });
  const logger = options.logger ?? defaultLogger();
  const onlyPluginIdSet = onlyPluginIds ? new Set(onlyPluginIds) : null;
  const getJiti = createPluginJitiLoader(options);
  const { registry, registerCli } = createPluginRegistry({
    activateGlobalSideEffects: false,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
    logger,
    runtime: {} as PluginRuntime,
  });

  const discovery = discoverOpenClawPlugins({
    cache: false,
    env,
    extraPaths: normalized.loadPaths,
    workspaceDir: options.workspaceDir,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: false,
    candidates: discovery.candidates,
    config: cfg,
    diagnostics: discovery.diagnostics,
    env,
    workspaceDir: options.workspaceDir,
  });
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenAllowlistIsOpen({
    allow: normalized.allow,
    discoverablePlugins: manifestRegistry.plugins
      .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
      .map((plugin) => ({
        id: plugin.id,
        origin: plugin.origin,
        source: plugin.source,
      })),
    emitWarning: false,
    logger,
    pluginsEnabled: normalized.enabled,
    warningCacheKey: `${cacheKey}::cli-metadata`,
  });
  const provenance = buildProvenanceIndex({
    config: cfg,
    env,
    normalizedLoadPaths: normalized.loadPaths,
  });
  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const orderedCandidates = [...discovery.candidates].toSorted((left, right) => compareDuplicateCandidateOrder({
      env,
      left,
      manifestByRoot,
      provenance,
      right,
    }));

  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;

  for (const candidate of orderedCandidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    if (
      !matchesScopedPluginRequest({
        onlyPluginIdSet,
        pluginId,
      })
    ) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      activationSource,
      autoEnabledReason: formatAutoEnabledActivationReason(autoEnabledReasons[pluginId]),
      config: normalized,
      enabledByDefault: manifestRecord.enabledByDefault,
      id: pluginId,
      origin: candidate.origin,
      rootConfig: cfg,
    });
    const existingOrigin = seenIds.get(pluginId);
    if (existingOrigin) {
      const record = createPluginRecord({
        activationState,
        bundleCapabilities: manifestRecord.bundleCapabilities,
        bundleFormat: manifestRecord.bundleFormat,
        configSchema: Boolean(manifestRecord.configSchema),
        contracts: manifestRecord.contracts,
        description: manifestRecord.description,
        enabled: false,
        format: manifestRecord.format,
        id: pluginId,
        name: manifestRecord.name ?? pluginId,
        origin: candidate.origin,
        rootDir: candidate.rootDir,
        source: candidate.source,
        version: manifestRecord.version,
        workspaceDir: candidate.workspaceDir,
      });
      record.status = "disabled";
      record.error = `overridden by ${existingOrigin} plugin`;
      markPluginActivationDisabled(record, record.error);
      registry.plugins.push(record);
      continue;
    }

    const enableState = resolveEffectiveEnableState({
      activationSource,
      config: normalized,
      enabledByDefault: manifestRecord.enabledByDefault,
      id: pluginId,
      origin: candidate.origin,
      rootConfig: cfg,
    });
    const entry = normalized.entries[pluginId];
    const record = createPluginRecord({
      activationState,
      bundleCapabilities: manifestRecord.bundleCapabilities,
      bundleFormat: manifestRecord.bundleFormat,
      configSchema: Boolean(manifestRecord.configSchema),
      contracts: manifestRecord.contracts,
      description: manifestRecord.description,
      enabled: enableState.enabled,
      format: manifestRecord.format,
      id: pluginId,
      name: manifestRecord.name ?? pluginId,
      origin: candidate.origin,
      rootDir: candidate.rootDir,
      source: candidate.source,
      version: manifestRecord.version,
      workspaceDir: candidate.workspaceDir,
    });
    record.kind = manifestRecord.kind;
    record.configUiHints = manifestRecord.configUiHints;
    record.configJsonSchema = manifestRecord.configSchema;
    const pushPluginLoadError = (message: string) => {
      record.status = "error";
      record.error = message;
      record.failedAt = new Date();
      record.failurePhase = "validation";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        message: record.error,
        pluginId: record.id,
        source: record.source,
      });
    };

    if (!enableState.enabled) {
      record.status = "disabled";
      record.error = enableState.reason;
      markPluginActivationDisabled(record, enableState.reason);
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (record.format === "bundle") {
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (!manifestRecord.configSchema) {
      pushPluginLoadError("missing config schema");
      continue;
    }

    const validatedConfig = validatePluginConfig({
      cacheKey: manifestRecord.schemaCacheKey,
      schema: manifestRecord.configSchema,
      value: entry?.config,
    });
    if (!validatedConfig.ok) {
      logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
      pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
      continue;
    }

    const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
    const cliMetadataSource = resolveCliMetadataEntrySource(candidate.rootDir);
    const sourceForCliMetadata =
      candidate.origin === "bundled" ? cliMetadataSource : (cliMetadataSource ?? candidate.source);
    if (!sourceForCliMetadata) {
      record.status = "loaded";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    const opened = openBoundaryFileSync({
      absolutePath: sourceForCliMetadata,
      boundaryLabel: "plugin root",
      rejectHardlinks: candidate.origin !== "bundled",
      rootPath: pluginRoot,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
      continue;
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);
    const safeImportSource = toSafeImportPath(safeSource);

    let mod: OpenClawPluginModule | null = null;
    try {
      mod = profilePluginLoaderSync({
        phase: "cli-metadata",
        pluginId: record.id,
        run: () => getJiti(safeSource)(safeImportSource) as OpenClawPluginModule,
        source: safeSource,
      });
    } catch (error) {
      recordPluginError({
        diagnosticMessagePrefix: "failed to load plugin: ",
        error: error,
        logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
        logger,
        origin: candidate.origin,
        phase: "load",
        pluginId,
        record,
        registry,
        seenIds,
      });
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const {definition} = resolved;
    const {register} = resolved;

    if (definition?.id && definition.id !== record.id) {
      pushPluginLoadError(
        `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
      );
      continue;
    }

    record.name = definition?.name ?? record.name;
    record.description = definition?.description ?? record.description;
    record.version = definition?.version ?? record.version;
    const manifestKind = record.kind;
    const exportKind = definition?.kind;
    if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) {
      registry.diagnostics.push({
        level: "warn",
        message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`,
        pluginId: record.id,
        source: record.source,
      });
    }
    record.kind = definition?.kind ?? record.kind;

    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      selectedId: selectedMemoryPluginId,
      slot: memorySlot,
    });
    if (!memoryDecision.enabled) {
      record.enabled = false;
      record.status = "disabled";
      record.error = memoryDecision.reason;
      markPluginActivationDisabled(record, memoryDecision.reason);
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      selectedMemoryPluginId = record.id;
      record.memorySlotSelected = true;
    }

    if (typeof register !== "function") {
      logger.error(`[plugins] ${record.id} missing register/activate export`);
      pushPluginLoadError("plugin export missing register/activate");
      continue;
    }

    const api = buildPluginApi({
      config: cfg,
      description: record.description,
      handlers: {
        registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      },
      id: record.id,
      logger,
      name: record.name,
      pluginConfig: validatedConfig.value,
      registrationMode: "cli-metadata",
      resolvePath: (input) => resolveUserPath(input),
      rootDir: record.rootDir,
      runtime: {} as PluginRuntime,
      source: record.source,
      version: record.version,
    });

    try {
      await register(api);
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
    } catch (error) {
      recordPluginError({
        diagnosticMessagePrefix: "plugin failed during register: ",
        error: error,
        logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
        logger,
        origin: candidate.origin,
        phase: "register",
        pluginId,
        record,
        registry,
        seenIds,
      });
    }
  }

  return registry;
}

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function resolveCliMetadataEntrySource(rootDir: string): string | null {
  for (const basename of CLI_METADATA_ENTRY_BASENAMES) {
    const candidate = path.join(rootDir, basename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
