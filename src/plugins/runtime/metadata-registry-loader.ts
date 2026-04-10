import type { OpenClawConfig } from "../../config/config.js";
import { loadOpenClawPlugins } from "../loader.js";
import type { PluginRegistry } from "../registry.js";
import { buildPluginRuntimeLoadOptions, resolvePluginRuntimeLoadContext } from "./load-context.js";

export function loadPluginMetadataRegistrySnapshot(options?: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  loadModules?: boolean;
}): PluginRegistry {
  const context = resolvePluginRuntimeLoadContext(options);

  return loadOpenClawPlugins(
    buildPluginRuntimeLoadOptions(context, {
      activate: false,
      cache: false,
      loadModules: options?.loadModules,
      mode: "validate",
      throwOnLoadError: true,
      ...(options?.onlyPluginIds?.length ? { onlyPluginIds: options.onlyPluginIds } : {}),
    }),
  );
}
