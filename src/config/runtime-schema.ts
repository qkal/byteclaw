import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadata,
  collectPluginSchemaMetadata,
} from "./channel-config-metadata.js";
import { loadConfig, readConfigFileSnapshot } from "./config.js";
import type { OpenClawConfig } from "./config.js";
import { type ConfigSchemaResponse, buildConfigSchema } from "./schema.js";

function loadManifestRegistry(config: OpenClawConfig, env?: NodeJS.ProcessEnv) {
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  return loadPluginManifestRegistry({
    cache: false,
    config,
    env,
    workspaceDir,
  });
}

export function loadGatewayRuntimeConfigSchema(): ConfigSchemaResponse {
  const config = loadConfig();
  const registry = loadManifestRegistry(config);
  return buildConfigSchema({
    channels: collectChannelSchemaMetadata(registry),
    plugins: collectPluginSchemaMetadata(registry),
  });
}

export async function readBestEffortRuntimeConfigSchema(): Promise<ConfigSchemaResponse> {
  const snapshot = await readConfigFileSnapshot();
  const config = snapshot.valid ? snapshot.config : { plugins: { enabled: true } };
  const registry = loadManifestRegistry(config);
  return buildConfigSchema({
    channels: collectChannelSchemaMetadata(registry),
    plugins: snapshot.valid ? collectPluginSchemaMetadata(registry) : [],
  });
}
