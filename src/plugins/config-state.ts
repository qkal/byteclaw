import type { OpenClawConfig } from "../config/config.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  resolveEnableStateResult,
  resolveEnableStateShared,
  resolveMemorySlotDecisionShared,
} from "./config-activation-shared.js";
import {
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
  hasExplicitPluginConfig as hasExplicitPluginConfigShared,
  isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared,
  normalizePluginsConfigWithResolver,
} from "./config-normalization-shared.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginOrigin } from "./types.js";

export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";

export type PluginExplicitSelectionCause =
  | "enabled-in-config"
  | "bundled-channel-enabled-in-config"
  | "selected-memory-slot"
  | "selected-in-allowlist";

export type PluginActivationCause =
  | PluginExplicitSelectionCause
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "disabled-in-config"
  | "workspace-disabled-by-default"
  | "not-in-allowlist"
  | "enabled-by-effective-config"
  | "bundled-channel-configured"
  | "bundled-default-enablement"
  | "bundled-disabled-by-default";

export interface PluginActivationState {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  reason?: string;
}

interface PluginActivationDecision {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  cause?: PluginActivationCause;
  reason?: string;
}

export interface PluginActivationConfigSource {
  plugins: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}

export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

let bundledPluginAliasLookupCache: ReadonlyMap<string, string> | undefined;

function getBundledPluginAliasLookup(): ReadonlyMap<string, string> {
  if (bundledPluginAliasLookupCache) {
    return bundledPluginAliasLookupCache;
  }

  const lookup = new Map<string, string>();
  for (const plugin of loadPluginManifestRegistry({ cache: true }).plugins) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    const pluginId = normalizeOptionalLowercaseString(plugin.id);
    if (pluginId) {
      lookup.set(pluginId, plugin.id);
    }
    for (const providerId of plugin.providers) {
      const normalizedProviderId = normalizeOptionalLowercaseString(providerId);
      if (normalizedProviderId) {
        lookup.set(normalizedProviderId, plugin.id);
      }
    }
    for (const legacyPluginId of plugin.legacyPluginIds ?? []) {
      const normalizedLegacyPluginId = normalizeOptionalLowercaseString(legacyPluginId);
      if (normalizedLegacyPluginId) {
        lookup.set(normalizedLegacyPluginId, plugin.id);
      }
    }
  }
  bundledPluginAliasLookupCache = lookup;
  return lookup;
}

export function normalizePluginId(id: string): string {
  const trimmed = normalizeOptionalString(id) ?? "";
  const normalized = normalizeOptionalLowercaseString(trimmed) ?? "";
  return getBundledPluginAliasLookup().get(normalized) ?? trimmed;
}

const PLUGIN_ACTIVATION_REASON_BY_CAUSE: Record<PluginActivationCause, string> = {
  "blocked-by-denylist": "blocked by denylist",
  "bundled-channel-configured": "channel configured",
  "bundled-channel-enabled-in-config": "channel enabled in config",
  "bundled-default-enablement": "bundled default enablement",
  "bundled-disabled-by-default": "bundled (disabled by default)",
  "disabled-in-config": "disabled in config",
  "enabled-by-effective-config": "enabled by effective config",
  "enabled-in-config": "enabled in config",
  "not-in-allowlist": "not in allowlist",
  "plugins-disabled": "plugins disabled",
  "selected-in-allowlist": "selected in allowlist",
  "selected-memory-slot": "selected memory slot",
  "workspace-disabled-by-default": "workspace plugin (disabled by default)",
};

function resolvePluginActivationReason(
  cause?: PluginActivationCause,
  reason?: string,
): string | undefined {
  if (reason) {
    return reason;
  }
  return cause ? PLUGIN_ACTIVATION_REASON_BY_CAUSE[cause] : undefined;
}

function toPluginActivationState(decision: PluginActivationDecision): PluginActivationState {
  return {
    activated: decision.activated,
    enabled: decision.enabled,
    explicitlyEnabled: decision.explicitlyEnabled,
    reason: resolvePluginActivationReason(decision.cause, decision.reason),
    source: decision.source,
  };
}

export const normalizePluginsConfig = (
  config?: OpenClawConfig["plugins"],
): NormalizedPluginsConfig => normalizePluginsConfigWithResolver(config, normalizePluginId);

export function createPluginActivationSource(params: {
  config?: OpenClawConfig;
  plugins?: NormalizedPluginsConfig;
}): PluginActivationConfigSource {
  return {
    plugins: params.plugins ?? normalizePluginsConfig(params.config?.plugins),
    rootConfig: params.config,
  };
}

const hasExplicitMemorySlot = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.slots && Object.hasOwn(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.entries && Object.hasOwn(plugins.entries, "memory-core"));

export const hasExplicitPluginConfig = (plugins?: OpenClawConfig["plugins"]) =>
  hasExplicitPluginConfigShared(plugins);

export function applyTestPluginDefaults(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!env.VITEST) {
    return cfg;
  }
  const {plugins} = cfg;
  const explicitConfig = hasExplicitPluginConfig(plugins);
  if (explicitConfig) {
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
      return cfg;
    }
    return {
      ...cfg,
      plugins: {
        ...plugins,
        slots: {
          ...plugins?.slots,
          memory: "none",
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...plugins,
      enabled: false,
      slots: {
        ...plugins?.slots,
        memory: "none",
      },
    },
  };
}

export function isTestDefaultMemorySlotDisabled(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.VITEST) {
    return false;
  }
  const {plugins} = cfg;
  if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
    return false;
  }
  return true;
}

function resolveExplicitPluginSelection(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): { explicitlyEnabled: boolean; cause?: PluginExplicitSelectionCause } {
  if (params.config.entries[params.id]?.enabled === true) {
    return { cause: "enabled-in-config", explicitlyEnabled: true };
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { cause: "bundled-channel-enabled-in-config", explicitlyEnabled: true };
  }
  if (params.config.slots.memory === params.id) {
    return { cause: "selected-memory-slot", explicitlyEnabled: true };
  }
  if (params.origin !== "bundled" && params.config.allow.includes(params.id)) {
    return { cause: "selected-in-allowlist", explicitlyEnabled: true };
  }
  return { explicitlyEnabled: false };
}

export function resolvePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  autoEnabledReason?: string;
}): PluginActivationState {
  const activationSource =
    params.activationSource ??
    createPluginActivationSource({
      config: params.rootConfig,
      plugins: params.config,
    });
  const explicitSelection = resolveExplicitPluginSelection({
    config: activationSource.plugins,
    id: params.id,
    origin: params.origin,
    rootConfig: activationSource.rootConfig,
  });

  if (!params.config.enabled) {
    return toPluginActivationState({
      activated: false,
      cause: "plugins-disabled",
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
    });
  }
  if (params.config.deny.includes(params.id)) {
    return toPluginActivationState({
      activated: false,
      cause: "blocked-by-denylist",
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
    });
  }
  const entry = params.config.entries[params.id];
  if (entry?.enabled === false) {
    return toPluginActivationState({
      activated: false,
      cause: "disabled-in-config",
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
    });
  }
  const explicitlyAllowed = params.config.allow.includes(params.id);
  if (params.origin === "workspace" && !explicitlyAllowed && entry?.enabled !== true) {
    return toPluginActivationState({
      activated: false,
      cause: "workspace-disabled-by-default",
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
    });
  }
  if (params.config.slots.memory === params.id) {
    return toPluginActivationState({
      activated: true,
      cause: "selected-memory-slot",
      enabled: true,
      explicitlyEnabled: true,
      source: "explicit",
    });
  }
  if (explicitSelection.cause === "bundled-channel-enabled-in-config") {
    return toPluginActivationState({
      activated: true,
      cause: explicitSelection.cause,
      enabled: true,
      explicitlyEnabled: true,
      source: "explicit",
    });
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return toPluginActivationState({
      activated: false,
      cause: "not-in-allowlist",
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      source: "disabled",
    });
  }
  if (explicitSelection.explicitlyEnabled) {
    return toPluginActivationState({
      activated: true,
      cause: explicitSelection.cause,
      enabled: true,
      explicitlyEnabled: true,
      source: "explicit",
    });
  }
  if (params.autoEnabledReason) {
    return toPluginActivationState({
      activated: true,
      enabled: true,
      explicitlyEnabled: false,
      reason: params.autoEnabledReason,
      source: "auto",
    });
  }
  if (entry?.enabled === true) {
    return toPluginActivationState({
      activated: true,
      cause: "enabled-by-effective-config",
      enabled: true,
      explicitlyEnabled: false,
      source: "auto",
    });
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return toPluginActivationState({
      activated: true,
      cause: "bundled-channel-configured",
      enabled: true,
      explicitlyEnabled: false,
      source: "auto",
    });
  }
  if (params.origin === "bundled" && params.enabledByDefault === true) {
    return toPluginActivationState({
      activated: true,
      cause: "bundled-default-enablement",
      enabled: true,
      explicitlyEnabled: false,
      source: "default",
    });
  }
  if (params.origin === "bundled") {
    return toPluginActivationState({
      activated: false,
      cause: "bundled-disabled-by-default",
      enabled: false,
      explicitlyEnabled: false,
      source: "disabled",
    });
  }
  return toPluginActivationState({
    activated: true,
    enabled: true,
    explicitlyEnabled: explicitSelection.explicitlyEnabled,
    source: "default",
  });
}

export function resolveEnableState(
  id: string,
  origin: PluginOrigin,
  config: NormalizedPluginsConfig,
  enabledByDefault?: boolean,
): { enabled: boolean; reason?: string } {
  return resolveEnableStateShared(
    { config, enabledByDefault, id, origin },
    resolvePluginActivationState,
  );
}

export function isBundledChannelEnabledByChannelConfig(
  cfg: OpenClawConfig | undefined,
  pluginId: string,
): boolean {
  return isBundledChannelEnabledByChannelConfigShared(cfg, pluginId);
}

export function resolveEffectiveEnableState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
}): { enabled: boolean; reason?: string } {
  return resolveEnableStateResult(params, resolveEffectivePluginActivationState);
}

export function resolveEffectivePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  autoEnabledReason?: string;
}): PluginActivationState {
  return resolvePluginActivationState(params);
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string | string[];
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  return resolveMemorySlotDecisionShared(params);
}
