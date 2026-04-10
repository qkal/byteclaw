import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "../../../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../../../plugins/manifest-registry.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { loadChannelOutboundAdapter } from "../outbound/load.js";
import { createChannelRegistryLoader } from "../registry-loader.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../types.js";

const loadChannelPlugin = createChannelRegistryLoader<ChannelPlugin>((entry) => entry.plugin);

const emptyRegistry = createTestRegistry([]);

const demoOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendMedia: async () => ({ channel: "demo-loader", messageId: "m2" }),
  sendText: async () => ({ channel: "demo-loader", messageId: "m1" }),
};

const demoLoaderPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    id: "demo-loader",
    label: "Demo Loader",
  }),
  outbound: demoOutbound,
};

const registryWithDemoLoader = createTestRegistry([
  { plugin: demoLoaderPlugin, pluginId: "demo-loader", source: "test" },
]);

const demoOutboundV2: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendMedia: async () => ({ channel: "demo-loader", messageId: "m4" }),
  sendText: async () => ({ channel: "demo-loader", messageId: "m3" }),
};

const demoLoaderPluginV2 = createOutboundTestPlugin({
  id: "demo-loader",
  label: "Demo Loader",
  outbound: demoOutboundV2,
});

const registryWithDemoLoaderV2 = createTestRegistry([
  { plugin: demoLoaderPluginV2, pluginId: "demo-loader", source: "test-v2" },
]);

const demoNoOutboundPlugin = createChannelTestPluginBase({
  id: "demo-loader",
  label: "Demo Loader",
});

const registryWithDemoLoaderNoOutbound = createTestRegistry([
  { plugin: demoNoOutboundPlugin, pluginId: "demo-loader", source: "test-no-outbound" },
]);

describe("channel plugin loader", () => {
  async function expectLoadedPluginCase(params: {
    registry: Parameters<typeof setActivePluginRegistry>[0];
    expectedPlugin: ChannelPlugin;
  }) {
    setActivePluginRegistry(params.registry);
    expect(await loadChannelPlugin("demo-loader")).toBe(params.expectedPlugin);
  }

  async function expectLoadedOutboundCase(params: {
    registry: Parameters<typeof setActivePluginRegistry>[0];
    expectedOutbound: ChannelOutboundAdapter | undefined;
  }) {
    setActivePluginRegistry(params.registry);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBe(params.expectedOutbound);
  }

  async function expectReloadedLoaderCase(params: {
    load: typeof loadChannelPlugin | typeof loadChannelOutboundAdapter;
    firstRegistry: Parameters<typeof setActivePluginRegistry>[0];
    secondRegistry: Parameters<typeof setActivePluginRegistry>[0];
    firstExpected: ChannelPlugin | ChannelOutboundAdapter | undefined;
    secondExpected: ChannelPlugin | ChannelOutboundAdapter | undefined;
  }) {
    setActivePluginRegistry(params.firstRegistry);
    expect(await params.load("demo-loader")).toBe(params.firstExpected);
    setActivePluginRegistry(params.secondRegistry);
    expect(await params.load("demo-loader")).toBe(params.secondExpected);
  }

  async function expectOutboundAdapterMissingCase(
    registry: Parameters<typeof setActivePluginRegistry>[0],
  ) {
    setActivePluginRegistry(registry);
    expect(await loadChannelOutboundAdapter("demo-loader")).toBeUndefined();
  }

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it.each([
    {
      expectedPlugin: demoLoaderPlugin,
      kind: "plugin" as const,
      name: "loads channel plugins from the active registry",
      registry: registryWithDemoLoader,
    },
    {
      expectedOutbound: demoOutbound,
      kind: "outbound" as const,
      name: "loads outbound adapters from registered plugins",
      registry: registryWithDemoLoader,
    },
    {
      firstExpected: demoLoaderPlugin,
      firstRegistry: registryWithDemoLoader,
      kind: "reload-plugin" as const,
      name: "refreshes cached plugin values when registry changes",
      secondExpected: demoLoaderPluginV2,
      secondRegistry: registryWithDemoLoaderV2,
    },
    {
      firstExpected: demoOutbound,
      firstRegistry: registryWithDemoLoader,
      kind: "reload-outbound" as const,
      name: "refreshes cached outbound values when registry changes",
      secondExpected: demoOutboundV2,
      secondRegistry: registryWithDemoLoaderV2,
    },
    {
      kind: "missing-outbound" as const,
      name: "returns undefined when plugin has no outbound adapter",
      registry: registryWithDemoLoaderNoOutbound,
    },
  ] as const)("$name", async (testCase) => {
    switch (testCase.kind) {
      case "plugin": {
        await expectLoadedPluginCase({
          expectedPlugin: testCase.expectedPlugin,
          registry: testCase.registry,
        });
        return;
      }
      case "outbound": {
        await expectLoadedOutboundCase({
          expectedOutbound: testCase.expectedOutbound,
          registry: testCase.registry,
        });
        return;
      }
      case "reload-plugin": {
        await expectReloadedLoaderCase({
          firstExpected: testCase.firstExpected,
          firstRegistry: testCase.firstRegistry,
          load: loadChannelPlugin,
          secondExpected: testCase.secondExpected,
          secondRegistry: testCase.secondRegistry,
        });
        return;
      }
      case "reload-outbound": {
        await expectReloadedLoaderCase({
          firstExpected: testCase.firstExpected,
          firstRegistry: testCase.firstRegistry,
          load: loadChannelOutboundAdapter,
          secondExpected: testCase.secondExpected,
          secondRegistry: testCase.secondRegistry,
        });
        return;
      }
      case "missing-outbound": {
        await expectOutboundAdapterMissingCase(testCase.registry);
        return;
      }
    }
  });
});
