import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackend } from "../plugins/setup-registry.js";
import type { CliBundleMcpMode } from "../plugins/types.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./model-selection.js";

export interface ResolvedCliBackend {
  id: string;
  config: CliBackendConfig;
  bundleMcp: boolean;
  bundleMcpMode?: CliBundleMcpMode;
  pluginId?: string;
}

export interface ResolvedCliBackendLiveTest {
  defaultModelRef?: string;
  defaultImageProbe: boolean;
  defaultMcpProbe: boolean;
  dockerNpmPackage?: string;
  dockerBinaryName?: string;
}

export function normalizeClaudeBackendConfig(config: CliBackendConfig): CliBackendConfig {
  const normalizeConfig = resolveFallbackCliBackendPolicy("claude-cli")?.normalizeConfig;
  return normalizeConfig ? normalizeConfig(config) : config;
}

interface FallbackCliBackendPolicy {
  bundleMcp: boolean;
  bundleMcpMode?: CliBundleMcpMode;
  baseConfig?: CliBackendConfig;
  normalizeConfig?: (config: CliBackendConfig) => CliBackendConfig;
}

const FALLBACK_CLI_BACKEND_POLICIES: Record<string, FallbackCliBackendPolicy> = {};

function normalizeBundleMcpMode(
  mode: CliBundleMcpMode | undefined,
  enabled: boolean,
): CliBundleMcpMode | undefined {
  if (!enabled) {
    return undefined;
  }
  return mode ?? "claude-config-file";
}

function resolveSetupCliBackendPolicy(provider: string): FallbackCliBackendPolicy | undefined {
  const entry = resolvePluginSetupCliBackend({
    backend: provider,
  });
  if (!entry) {
    return undefined;
  }
  return {
    // Setup-registered backends keep narrow CLI paths generic even when the
    // Runtime plugin registry has not booted yet.
    baseConfig: entry.backend.config,
    bundleMcp: entry.backend.bundleMcp === true,
    bundleMcpMode: normalizeBundleMcpMode(
      entry.backend.bundleMcpMode,
      entry.backend.bundleMcp === true,
    ),
    normalizeConfig: entry.backend.normalizeConfig,
  };
}

function resolveFallbackCliBackendPolicy(provider: string): FallbackCliBackendPolicy | undefined {
  return FALLBACK_CLI_BACKEND_POLICIES[provider] ?? resolveSetupCliBackendPolicy(provider);
}

function normalizeBackendKey(key: string): string {
  return normalizeProviderId(key);
}

function pickBackendConfig(
  config: Record<string, CliBackendConfig>,
  normalizedId: string,
): CliBackendConfig | undefined {
  const directKey = Object.keys(config).find(
    (key) => normalizeOptionalLowercaseString(key) === normalizedId,
  );
  if (directKey) {
    return config[directKey];
  }
  for (const [key, entry] of Object.entries(config)) {
    if (normalizeBackendKey(key) === normalizedId) {
      return entry;
    }
  }
  return undefined;
}

function resolveRegisteredBackend(provider: string) {
  const normalized = normalizeBackendKey(provider);
  return resolveRuntimeCliBackends().find((entry) => normalizeBackendKey(entry.id) === normalized);
}

function mergeBackendConfig(base: CliBackendConfig, override?: CliBackendConfig): CliBackendConfig {
  if (!override) {
    return { ...base };
  }
  const baseFresh = base.reliability?.watchdog?.fresh ?? {};
  const baseResume = base.reliability?.watchdog?.resume ?? {};
  const overrideFresh = override.reliability?.watchdog?.fresh ?? {};
  const overrideResume = override.reliability?.watchdog?.resume ?? {};
  return {
    ...base,
    ...override,
    args: override.args ?? base.args,
    clearEnv: [...new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])])],
    env: { ...base.env, ...override.env },
    modelAliases: { ...base.modelAliases, ...override.modelAliases },
    reliability: {
      ...base.reliability,
      ...override.reliability,
      watchdog: {
        ...base.reliability?.watchdog,
        ...override.reliability?.watchdog,
        fresh: {
          ...baseFresh,
          ...overrideFresh,
        },
        resume: {
          ...baseResume,
          ...overrideResume,
        },
      },
    },
    resumeArgs: override.resumeArgs ?? base.resumeArgs,
    sessionArgs: override.sessionArgs ?? base.sessionArgs,
    sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
  };
}

export function resolveCliBackendIds(cfg?: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  for (const backend of resolveRuntimeCliBackends()) {
    ids.add(normalizeBackendKey(backend.id));
  }
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  for (const key of Object.keys(configured)) {
    ids.add(normalizeBackendKey(key));
  }
  return ids;
}

export function resolveCliBackendLiveTest(provider: string): ResolvedCliBackendLiveTest | null {
  const normalized = normalizeBackendKey(provider);
  const entry =
    resolvePluginSetupCliBackend({ backend: normalized }) ??
    resolveRuntimeCliBackends().find((backend) => normalizeBackendKey(backend.id) === normalized);
  if (!entry) {
    return null;
  }
  const backend = "backend" in entry ? entry.backend : entry;
  return {
    defaultImageProbe: backend.liveTest?.defaultImageProbe === true,
    defaultMcpProbe: backend.liveTest?.defaultMcpProbe === true,
    defaultModelRef: backend.liveTest?.defaultModelRef,
    dockerBinaryName: backend.liveTest?.docker?.binaryName,
    dockerNpmPackage: backend.liveTest?.docker?.npmPackage,
  };
}

export function resolveCliBackendConfig(
  provider: string,
  cfg?: OpenClawConfig,
): ResolvedCliBackend | null {
  const normalized = normalizeBackendKey(provider);
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  const override = pickBackendConfig(configured, normalized);
  const registered = resolveRegisteredBackend(normalized);
  if (registered) {
    const merged = mergeBackendConfig(registered.config, override);
    const config = registered.normalizeConfig ? registered.normalizeConfig(merged) : merged;
    const command = config.command?.trim();
    if (!command) {
      return null;
    }
    return {
      bundleMcp: registered.bundleMcp === true,
      bundleMcpMode: normalizeBundleMcpMode(
        registered.bundleMcpMode,
        registered.bundleMcp === true,
      ),
      config: { ...config, command },
      id: normalized,
      pluginId: registered.pluginId,
    };
  }

  const fallbackPolicy = resolveFallbackCliBackendPolicy(normalized);
  if (!override) {
    if (!fallbackPolicy?.baseConfig) {
      return null;
    }
    const baseConfig = fallbackPolicy.normalizeConfig
      ? fallbackPolicy.normalizeConfig(fallbackPolicy.baseConfig)
      : fallbackPolicy.baseConfig;
    const command = baseConfig.command?.trim();
    if (!command) {
      return null;
    }
    return {
      bundleMcp: fallbackPolicy.bundleMcp,
      bundleMcpMode: fallbackPolicy.bundleMcpMode,
      config: { ...baseConfig, command },
      id: normalized,
    };
  }
  const mergedFallback = fallbackPolicy?.baseConfig
    ? mergeBackendConfig(fallbackPolicy.baseConfig, override)
    : override;
  const config = fallbackPolicy?.normalizeConfig
    ? fallbackPolicy.normalizeConfig(mergedFallback)
    : mergedFallback;
  const command = config.command?.trim();
  if (!command) {
    return null;
  }
  return {
    bundleMcp: fallbackPolicy?.bundleMcp === true,
    bundleMcpMode: fallbackPolicy?.bundleMcpMode,
    config: { ...config, command },
    id: normalized,
  };
}
