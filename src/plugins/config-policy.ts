import type { OpenClawConfig } from "../config/config.js";
import {
  resolveEnableStateResult,
  resolveEnableStateShared,
  resolveMemorySlotDecisionShared,
} from "./config-activation-shared.js";
import {
  type NormalizePluginId,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
  hasExplicitPluginConfig as hasExplicitPluginConfigShared,
  identityNormalizePluginId,
  isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared,
  normalizePluginsConfigWithResolver as normalizePluginsConfigWithResolverShared,
} from "./config-normalization-shared.js";
import type { PluginKind, PluginOrigin } from "./types.js";

export type PluginActivationSource = "disabled" | "explicit" | "auto" | "default";

export interface PluginActivationState {
  enabled: boolean;
  activated: boolean;
  explicitlyEnabled: boolean;
  source: PluginActivationSource;
  reason?: string;
}

export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

export function normalizePluginsConfigWithResolver(
  config?: OpenClawConfig["plugins"],
  normalizePluginId: NormalizePluginId = identityNormalizePluginId,
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolverShared(config, normalizePluginId);
}

function resolveExplicitPluginSelection(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): { explicitlyEnabled: boolean; reason?: string } {
  if (params.config.entries[params.id]?.enabled === true) {
    return { explicitlyEnabled: true, reason: "enabled in config" };
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return { explicitlyEnabled: true, reason: "channel enabled in config" };
  }
  if (params.config.slots.memory === params.id) {
    return { explicitlyEnabled: true, reason: "selected memory slot" };
  }
  if (params.origin !== "bundled" && params.config.allow.includes(params.id)) {
    return { explicitlyEnabled: true, reason: "selected in allowlist" };
  }
  return { explicitlyEnabled: false };
}

export function resolvePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: OpenClawConfig;
  autoEnabledReason?: string;
}): PluginActivationState {
  const explicitSelection = resolveExplicitPluginSelection({
    config: params.sourceConfig ?? params.config,
    id: params.id,
    origin: params.origin,
    rootConfig: params.sourceRootConfig ?? params.rootConfig,
  });

  if (!params.config.enabled) {
    return {
      activated: false,
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      reason: "plugins disabled",
      source: "disabled",
    };
  }
  if (params.config.deny.includes(params.id)) {
    return {
      activated: false,
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      reason: "blocked by denylist",
      source: "disabled",
    };
  }
  const entry = params.config.entries[params.id];
  if (entry?.enabled === false) {
    return {
      activated: false,
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      reason: "disabled in config",
      source: "disabled",
    };
  }
  const explicitlyAllowed = params.config.allow.includes(params.id);
  if (params.origin === "workspace" && !explicitlyAllowed && entry?.enabled !== true) {
    return {
      activated: false,
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      reason: "workspace plugin (disabled by default)",
      source: "disabled",
    };
  }
  if (params.config.slots.memory === params.id) {
    return {
      activated: true,
      enabled: true,
      explicitlyEnabled: true,
      reason: "selected memory slot",
      source: "explicit",
    };
  }
  if (params.config.allow.length > 0 && !explicitlyAllowed) {
    return {
      activated: false,
      enabled: false,
      explicitlyEnabled: explicitSelection.explicitlyEnabled,
      reason: "not in allowlist",
      source: "disabled",
    };
  }
  if (explicitSelection.explicitlyEnabled) {
    return {
      activated: true,
      enabled: true,
      explicitlyEnabled: true,
      reason: explicitSelection.reason,
      source: "explicit",
    };
  }
  if (params.autoEnabledReason) {
    return {
      activated: true,
      enabled: true,
      explicitlyEnabled: false,
      reason: params.autoEnabledReason,
      source: "auto",
    };
  }
  if (entry?.enabled === true) {
    return {
      activated: true,
      enabled: true,
      explicitlyEnabled: false,
      reason: "enabled by effective config",
      source: "auto",
    };
  }
  if (
    params.origin === "bundled" &&
    isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)
  ) {
    return {
      activated: true,
      enabled: true,
      explicitlyEnabled: false,
      reason: "channel configured",
      source: "auto",
    };
  }
  if (params.origin === "bundled" && params.enabledByDefault === true) {
    return {
      activated: true,
      enabled: true,
      explicitlyEnabled: false,
      reason: "bundled default enablement",
      source: "default",
    };
  }
  if (params.origin === "bundled") {
    return {
      activated: false,
      enabled: false,
      explicitlyEnabled: false,
      reason: "bundled (disabled by default)",
      source: "disabled",
    };
  }
  return {
    activated: true,
    enabled: true,
    explicitlyEnabled: explicitSelection.explicitlyEnabled,
    source: "default",
  };
}
export function hasExplicitPluginConfig(plugins?: OpenClawConfig["plugins"]): boolean {
  return hasExplicitPluginConfigShared(plugins);
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
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: OpenClawConfig;
  autoEnabledReason?: string;
}): { enabled: boolean; reason?: string } {
  return resolveEnableStateResult(params, resolveEffectivePluginActivationState);
}

export function resolveEffectivePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: OpenClawConfig;
  autoEnabledReason?: string;
}): PluginActivationState {
  return resolvePluginActivationState(params);
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: PluginKind | PluginKind[];
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  return resolveMemorySlotDecisionShared(params);
}
