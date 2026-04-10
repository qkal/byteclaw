import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolvePluginInstallDir } from "./install.js";
import { defaultSlotIdForKey } from "./slots.js";

export interface UninstallActions {
  entry: boolean;
  install: boolean;
  allowlist: boolean;
  loadPath: boolean;
  memorySlot: boolean;
  channelConfig: boolean;
  directory: boolean;
}

export type UninstallPluginResult =
  | {
      ok: true;
      config: OpenClawConfig;
      pluginId: string;
      actions: UninstallActions;
      warnings: string[];
    }
  | { ok: false; error: string };

export function resolveUninstallDirectoryTarget(params: {
  pluginId: string;
  hasInstall: boolean;
  installRecord?: PluginInstallRecord;
  extensionsDir?: string;
}): string | null {
  if (!params.hasInstall) {
    return null;
  }

  if (params.installRecord?.source === "path") {
    return null;
  }

  let defaultPath: string;
  try {
    defaultPath = resolvePluginInstallDir(params.pluginId, params.extensionsDir);
  } catch {
    return null;
  }

  const configuredPath = params.installRecord?.installPath;
  if (!configuredPath) {
    return defaultPath;
  }

  if (path.resolve(configuredPath) === path.resolve(defaultPath)) {
    return configuredPath;
  }

  // Never trust configured installPath blindly for recursive deletes.
  return defaultPath;
}

const SHARED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

/**
 * Resolve the channel config keys owned by a plugin during uninstall.
 * - `channelIds === undefined`: fall back to the plugin id for backward compatibility.
 * - `channelIds === []`: explicit "owns no channels" signal; remove nothing.
 */
export function resolveUninstallChannelConfigKeys(
  pluginId: string,
  opts?: { channelIds?: string[] },
): string[] {
  const rawKeys = opts?.channelIds ?? [pluginId];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of rawKeys) {
    if (SHARED_CHANNEL_CONFIG_KEYS.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Remove plugin references from config (pure config mutation).
 * Returns a new config with the plugin removed from entries, installs, allow, load.paths, slots,
 * and owned channel config.
 */
export function removePluginFromConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  opts?: { channelIds?: string[] },
): { config: OpenClawConfig; actions: Omit<UninstallActions, "directory"> } {
  const actions: Omit<UninstallActions, "directory"> = {
    allowlist: false,
    channelConfig: false,
    entry: false,
    install: false,
    loadPath: false,
    memorySlot: false,
  };

  const pluginsConfig = cfg.plugins ?? {};

  // Remove from entries
  let { entries } = pluginsConfig;
  if (entries && pluginId in entries) {
    const { [pluginId]: _, ...rest } = entries;
    entries = Object.keys(rest).length > 0 ? rest : undefined;
    actions.entry = true;
  }

  // Remove from installs
  let { installs } = pluginsConfig;
  const installRecord = installs?.[pluginId];
  if (installs && pluginId in installs) {
    const { [pluginId]: _, ...rest } = installs;
    installs = Object.keys(rest).length > 0 ? rest : undefined;
    actions.install = true;
  }

  // Remove from allowlist
  let { allow } = pluginsConfig;
  if (Array.isArray(allow) && allow.includes(pluginId)) {
    allow = allow.filter((id) => id !== pluginId);
    if (allow.length === 0) {
      allow = undefined;
    }
    actions.allowlist = true;
  }

  // Remove linked path from load.paths (for source === "path" plugins)
  let { load } = pluginsConfig;
  if (installRecord?.source === "path" && installRecord.sourcePath) {
    const { sourcePath } = installRecord;
    const loadPaths = load?.paths;
    if (Array.isArray(loadPaths) && loadPaths.includes(sourcePath)) {
      const nextLoadPaths = loadPaths.filter((p) => p !== sourcePath);
      load = nextLoadPaths.length > 0 ? { ...load, paths: nextLoadPaths } : undefined;
      actions.loadPath = true;
    }
  }

  // Reset memory slot if this plugin was selected
  let { slots } = pluginsConfig;
  if (slots?.memory === pluginId) {
    slots = {
      ...slots,
      memory: defaultSlotIdForKey("memory"),
    };
    actions.memorySlot = true;
  }
  if (slots && Object.keys(slots).length === 0) {
    slots = undefined;
  }

  const newPlugins = {
    ...pluginsConfig,
    allow,
    entries,
    installs,
    load,
    slots,
  };

  // Clean up undefined properties from newPlugins
  const cleanedPlugins: typeof newPlugins = { ...newPlugins };
  if (cleanedPlugins.entries === undefined) {
    delete cleanedPlugins.entries;
  }
  if (cleanedPlugins.installs === undefined) {
    delete cleanedPlugins.installs;
  }
  if (cleanedPlugins.allow === undefined) {
    delete cleanedPlugins.allow;
  }
  if (cleanedPlugins.load === undefined) {
    delete cleanedPlugins.load;
  }
  if (cleanedPlugins.slots === undefined) {
    delete cleanedPlugins.slots;
  }

  // Remove channel config owned by this installed plugin.
  // Built-in channels have no install record, so keep their config untouched.
  const hasInstallRecord = Object.hasOwn(cfg.plugins?.installs ?? {}, pluginId);
  let channels = cfg.channels as Record<string, unknown> | undefined;
  if (hasInstallRecord && channels) {
    for (const key of resolveUninstallChannelConfigKeys(pluginId, opts)) {
      if (!Object.hasOwn(channels, key)) {
        continue;
      }
      const { [key]: _removed, ...rest } = channels;
      channels = Object.keys(rest).length > 0 ? rest : undefined;
      actions.channelConfig = true;
      if (!channels) {
        break;
      }
    }
  }

  const config: OpenClawConfig = {
    ...cfg,
    channels: channels as OpenClawConfig["channels"],
    plugins: Object.keys(cleanedPlugins).length > 0 ? cleanedPlugins : undefined,
  };

  return { actions, config };
}

export interface UninstallPluginParams {
  config: OpenClawConfig;
  pluginId: string;
  channelIds?: string[];
  deleteFiles?: boolean;
  extensionsDir?: string;
}

/**
 * Uninstall a plugin by removing it from config and optionally deleting installed files.
 * Linked plugins (source === "path") never have their source directory deleted.
 */
export async function uninstallPlugin(
  params: UninstallPluginParams,
): Promise<UninstallPluginResult> {
  const { config, pluginId, channelIds, deleteFiles = true, extensionsDir } = params;

  // Validate plugin exists
  const hasEntry = pluginId in (config.plugins?.entries ?? {});
  const hasInstall = pluginId in (config.plugins?.installs ?? {});

  if (!hasEntry && !hasInstall) {
    return { error: `Plugin not found: ${pluginId}`, ok: false };
  }

  const installRecord = config.plugins?.installs?.[pluginId];
  const isLinked = installRecord?.source === "path";

  // Remove from config
  const { config: newConfig, actions: configActions } = removePluginFromConfig(config, pluginId, {
    channelIds,
  });

  const actions: UninstallActions = {
    ...configActions,
    directory: false,
  };
  const warnings: string[] = [];

  const deleteTarget =
    deleteFiles && !isLinked
      ? resolveUninstallDirectoryTarget({
          extensionsDir,
          hasInstall,
          installRecord,
          pluginId,
        })
      : null;

  // Delete installed directory if requested and safe.
  if (deleteTarget) {
    const existed =
      (await fs
        .access(deleteTarget)
        .then(() => true)
        .catch(() => false)) ?? false;
    try {
      await fs.rm(deleteTarget, { force: true, recursive: true });
      actions.directory = existed;
    } catch (error) {
      warnings.push(
        `Failed to remove plugin directory ${deleteTarget}: ${formatErrorMessage(error)}`,
      );
      // Directory deletion failure is not fatal; config is the source of truth.
    }
  }

  return {
    actions,
    config: newConfig,
    ok: true,
    pluginId,
    warnings,
  };
}
