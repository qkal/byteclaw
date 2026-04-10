import type { OpenClawConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import {
  type NormalizedPluginsConfig,
  type PluginActivationConfigSource,
  createPluginActivationSource,
  normalizePluginsConfig,
} from "./config-state.js";

export interface PluginActivationCompatConfig {
  allowlistPluginIds?: readonly string[];
  enablementPluginIds?: readonly string[];
  vitestPluginIds?: readonly string[];
}

export interface PluginActivationBundledCompatMode {
  allowlist?: boolean;
  enablement?: "always" | "allowlist";
  vitest?: boolean;
}

export interface PluginActivationInputs {
  rawConfig?: OpenClawConfig;
  config?: OpenClawConfig;
  normalized: NormalizedPluginsConfig;
  activationSourceConfig?: OpenClawConfig;
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Record<string, string[]>;
}

export type PluginActivationSnapshot = Pick<
  PluginActivationInputs,
  | "rawConfig"
  | "config"
  | "normalized"
  | "activationSourceConfig"
  | "activationSource"
  | "autoEnabledReasons"
>;

export type BundledPluginCompatibleActivationInputs = PluginActivationInputs & {
  compatPluginIds: string[];
};

export function withActivatedPluginIds(params: {
  config?: OpenClawConfig;
  pluginIds: readonly string[];
}): OpenClawConfig | undefined {
  if (params.pluginIds.length === 0) {
    return params.config;
  }
  const allow = new Set(params.config?.plugins?.allow ?? []);
  const entries = {
    ...params.config?.plugins?.entries,
  };
  for (const pluginId of params.pluginIds) {
    const normalized = pluginId.trim();
    if (!normalized) {
      continue;
    }
    allow.add(normalized);
    entries[normalized] = {
      ...entries[normalized],
      enabled: true,
    };
  }
  const forcePluginsEnabled = params.config?.plugins?.enabled === false;
  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      ...(forcePluginsEnabled ? { enabled: true } : {}),
      ...(allow.size > 0 ? { allow: [...allow] } : {}),
      entries,
    },
  };
}

export function applyPluginCompatibilityOverrides(params: {
  config?: OpenClawConfig;
  compat?: PluginActivationCompatConfig;
  env: NodeJS.ProcessEnv;
}): OpenClawConfig | undefined {
  const allowlistCompat = params.compat?.allowlistPluginIds?.length
    ? withBundledPluginAllowlistCompat({
        config: params.config,
        pluginIds: params.compat.allowlistPluginIds,
      })
    : params.config;
  const enablementCompat = params.compat?.enablementPluginIds?.length
    ? withBundledPluginEnablementCompat({
        config: allowlistCompat,
        pluginIds: params.compat.enablementPluginIds,
      })
    : allowlistCompat;
  const vitestCompat = params.compat?.vitestPluginIds?.length
    ? withBundledPluginVitestCompat({
        config: enablementCompat,
        env: params.env,
        pluginIds: params.compat.vitestPluginIds,
      })
    : enablementCompat;
  return vitestCompat;
}

export function resolvePluginActivationSnapshot(params: {
  rawConfig?: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
}): PluginActivationSnapshot {
  const env = params.env ?? process.env;
  const rawConfig = params.rawConfig ?? params.resolvedConfig;
  let resolvedConfig = params.resolvedConfig ?? params.rawConfig;
  let { autoEnabledReasons } = params;

  if (params.applyAutoEnable && rawConfig !== undefined) {
    const autoEnabled = applyPluginAutoEnable({
      config: rawConfig,
      env,
    });
    resolvedConfig = autoEnabled.config;
    ({ autoEnabledReasons } = autoEnabled);
  }

  return {
    activationSource: createPluginActivationSource({
      config: rawConfig,
    }),
    activationSourceConfig: rawConfig,
    autoEnabledReasons: autoEnabledReasons ?? {},
    config: resolvedConfig,
    normalized: normalizePluginsConfig(resolvedConfig?.plugins),
    rawConfig,
  };
}

export function resolvePluginActivationInputs(params: {
  rawConfig?: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  compat?: PluginActivationCompatConfig;
  applyAutoEnable?: boolean;
}): PluginActivationInputs {
  const env = params.env ?? process.env;
  const snapshot = resolvePluginActivationSnapshot({
    applyAutoEnable: params.applyAutoEnable,
    autoEnabledReasons: params.autoEnabledReasons,
    env,
    rawConfig: params.rawConfig,
    resolvedConfig: params.resolvedConfig,
  });
  const config = applyPluginCompatibilityOverrides({
    compat: params.compat,
    config: snapshot.config,
    env,
  });

  return {
    activationSource: snapshot.activationSource,
    activationSourceConfig: snapshot.activationSourceConfig,
    autoEnabledReasons: snapshot.autoEnabledReasons,
    config,
    normalized: normalizePluginsConfig(config?.plugins),
    rawConfig: snapshot.rawConfig,
  };
}

export function resolveBundledPluginCompatibleActivationInputs(params: {
  rawConfig?: OpenClawConfig;
  resolvedConfig?: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  applyAutoEnable?: boolean;
  compatMode: PluginActivationBundledCompatMode;
  resolveCompatPluginIds: (params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: readonly string[];
  }) => string[];
}): BundledPluginCompatibleActivationInputs {
  const snapshot = resolvePluginActivationSnapshot({
    applyAutoEnable: params.applyAutoEnable,
    autoEnabledReasons: params.autoEnabledReasons,
    env: params.env,
    rawConfig: params.rawConfig,
    resolvedConfig: params.resolvedConfig,
  });
  const allowlistCompatEnabled = params.compatMode.allowlist === true;
  const shouldResolveCompatPluginIds =
    allowlistCompatEnabled ||
    params.compatMode.enablement === "always" ||
    (params.compatMode.enablement === "allowlist" && allowlistCompatEnabled) ||
    params.compatMode.vitest === true;
  const compatPluginIds = shouldResolveCompatPluginIds
    ? params.resolveCompatPluginIds({
        config: snapshot.config,
        env: params.env,
        onlyPluginIds: params.onlyPluginIds,
        workspaceDir: params.workspaceDir,
      })
    : [];
  const activation = resolvePluginActivationInputs({
    autoEnabledReasons: snapshot.autoEnabledReasons,
    compat: {
      allowlistPluginIds: allowlistCompatEnabled ? compatPluginIds : undefined,
      enablementPluginIds:
        params.compatMode.enablement === "always" ||
        (params.compatMode.enablement === "allowlist" && allowlistCompatEnabled)
          ? compatPluginIds
          : undefined,
      vitestPluginIds: params.compatMode.vitest ? compatPluginIds : undefined,
    },
    env: params.env,
    rawConfig: snapshot.rawConfig,
    resolvedConfig: snapshot.config,
  });

  return {
    ...activation,
    compatPluginIds,
  };
}
