import fs from "node:fs";
import path from "node:path";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import {
  type PluginManifestRegistry,
  clearPluginManifestRegistryCache,
} from "../plugins/manifest-registry.js";
import { clearPluginSetupRegistryCache } from "../plugins/setup-registry.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

export function resetPluginAutoEnableTestState(): void {
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  clearPluginSetupRegistryCache();
  cleanupTrackedTempDirs(tempDirs);
}

export function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-plugin-auto-enable", tempDirs);
}

export function makeIsolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const rootDir = makeTempDir();
  return {
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    ...overrides,
  };
}

export function writePluginManifestFixture(params: {
  rootDir: string;
  id: string;
  channels: string[];
}): void {
  mkdirSafeDir(params.rootDir);
  fs.writeFileSync(
    path.join(params.rootDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        channels: params.channels,
        configSchema: { type: "object" },
        id: params.id,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(params.rootDir, "index.ts"), "export default {}", "utf8");
}

export function makeRegistry(
  plugins: {
    id: string;
    channels: string[];
    autoEnableWhenConfiguredProviders?: string[];
    modelSupport?: { modelPrefixes?: string[]; modelPatterns?: string[] };
    contracts?: { webSearchProviders?: string[]; webFetchProviders?: string[]; tools?: string[] };
    providers?: string[];
    configSchema?: Record<string, unknown>;
    channelConfigs?: Record<string, { schema: Record<string, unknown>; preferOver?: string[] }>;
  }[],
): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: plugins.map((plugin) => ({
      autoEnableWhenConfiguredProviders: plugin.autoEnableWhenConfiguredProviders,
      channelConfigs: plugin.channelConfigs,
      channels: plugin.channels,
      cliBackends: [],
      configSchema: plugin.configSchema,
      contracts: plugin.contracts,
      hooks: [],
      id: plugin.id,
      manifestPath: `/fake/${plugin.id}/openclaw.plugin.json`,
      modelSupport: plugin.modelSupport,
      origin: "config" as const,
      providers: plugin.providers ?? [],
      rootDir: `/fake/${plugin.id}`,
      skills: [],
      source: `/fake/${plugin.id}/index.js`,
    })),
  };
}

export function makeApnChannelConfig() {
  return { channels: { apn: { someKey: "value" } } };
}

export function makeBluebubblesAndImessageChannels() {
  return {
    bluebubbles: { password: "x", serverUrl: "http://localhost:1234" },
    imessage: { cliPath: "/usr/local/bin/imsg" },
  };
}
