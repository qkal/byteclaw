import { discoverOpenClawPlugins } from "./discovery.js";
import {
  type PluginPackageChannel,
  type PluginPackageInstall,
  loadPluginManifest,
} from "./manifest.js";
import type { PluginOrigin } from "./types.js";

export interface PluginChannelCatalogEntry {
  pluginId: string;
  origin: PluginOrigin;
  packageName?: string;
  workspaceDir?: string;
  rootDir: string;
  channel: PluginPackageChannel;
  install?: PluginPackageInstall;
}

export function listChannelCatalogEntries(
  params: {
    origin?: PluginOrigin;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): PluginChannelCatalogEntry[] {
  return discoverOpenClawPlugins({
    env: params.env,
    workspaceDir: params.workspaceDir,
  }).candidates.flatMap((candidate) => {
    if (params.origin && candidate.origin !== params.origin) {
      return [];
    }
    const channel = candidate.packageManifest?.channel;
    if (!channel?.id) {
      return [];
    }
    const manifest = loadPluginManifest(candidate.rootDir, candidate.origin !== "bundled");
    if (!manifest.ok) {
      return [];
    }
    return [
      {
        channel,
        origin: candidate.origin,
        packageName: candidate.packageName,
        pluginId: manifest.manifest.id,
        rootDir: candidate.rootDir,
        workspaceDir: candidate.workspaceDir,
        ...(candidate.packageManifest?.install
          ? { install: candidate.packageManifest.install }
          : {}),
      },
    ];
  });
}
