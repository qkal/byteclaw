import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  findBundledPluginMetadataById: vi.fn(),
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("./bundled-plugin-metadata.js", () => ({
  findBundledPluginMetadataById: mocks.findBundledPluginMetadataById,
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: mocks.loadPluginManifestRegistry,
}));

import { resolvePluginConfigContractsById } from "./config-contracts.js";

function createRegistry(plugins: PluginManifestRegistry["plugins"]): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins,
  };
}

describe("resolvePluginConfigContractsById", () => {
  beforeEach(() => {
    mocks.findBundledPluginMetadataById.mockReset();
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue(createRegistry([]));
  });

  it("does not fall back to bundled metadata when registry already resolved a plugin without config contracts", () => {
    mocks.loadPluginManifestRegistry.mockReturnValue(
      createRegistry([
        {
          autoEnableWhenConfiguredProviders: undefined,
          bundleCapabilities: undefined,
          bundleFormat: undefined,
          channelCatalogMeta: undefined,
          channelConfigs: undefined,
          channelEnvVars: undefined,
          channels: [],
          cliBackends: [],
          configContracts: undefined,
          configSchema: undefined,
          configUiHints: undefined,
          contracts: undefined,
          description: undefined,
          enabledByDefault: undefined,
          format: undefined,
          hooks: [],
          id: "brave",
          kind: undefined,
          legacyPluginIds: undefined,
          manifestPath: "/tmp/brave/openclaw.plugin.json",
          modelSupport: undefined,
          name: undefined,
          origin: "bundled",
          providerAuthAliases: undefined,
          providerAuthChoices: undefined,
          providerAuthEnvVars: undefined,
          providers: [],
          rootDir: "/tmp/brave",
          settingsFiles: undefined,
          setupSource: undefined,
          skills: [],
          source: "/tmp/brave/openclaw.plugin.json",
          startupDeferConfiguredChannelFullLoadUntilAfterListen: undefined,
          version: undefined,
        },
      ]),
    );

    expect(
      resolvePluginConfigContractsById({
        pluginIds: ["brave"],
      }),
    ).toEqual(new Map());
    expect(mocks.findBundledPluginMetadataById).not.toHaveBeenCalled();
  });
});
