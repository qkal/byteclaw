import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "../../../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../../../plugins/manifest-registry.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { listChannelPlugins } from "../index.js";
import type { ChannelPlugin } from "../types.js";

describe("channel plugin registry", () => {
  const emptyRegistry = createTestRegistry([]);

  const createPlugin = (id: string, order?: number): ChannelPlugin => ({
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    id,
    meta: {
      blurb: "test",
      docsPath: `/channels/${id}`,
      id,
      label: id,
      selectionLabel: id,
      ...(order === undefined ? {} : { order }),
    },
  });

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  function expectListedChannelPluginIds(expectedIds: string[]) {
    expect(listChannelPlugins().map((plugin) => plugin.id)).toEqual(expectedIds);
  }

  function expectRegistryActivationCase(run: () => void) {
    run();
  }

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it.each([
    {
      name: "sorts channel plugins by configured order",
      run: () => {
        const orderedPlugins: [string, number][] = [
          ["demo-middle", 20],
          ["demo-first", 10],
          ["demo-last", 30],
        ];
        const registry = createTestRegistry(
          orderedPlugins.map(([id, order]) => ({
            plugin: createPlugin(id, order),
            pluginId: id,
            source: "test",
          })),
        );
        setActivePluginRegistry(registry);
        expectListedChannelPluginIds(["demo-first", "demo-middle", "demo-last"]);
      },
    },
    {
      name: "refreshes cached channel lookups when the same registry instance is re-activated",
      run: () => {
        const registry = createTestRegistry([
          {
            plugin: createPlugin("demo-alpha"),
            pluginId: "demo-alpha",
            source: "test",
          },
        ]);
        setActivePluginRegistry(registry, "registry-test");
        expectListedChannelPluginIds(["demo-alpha"]);

        registry.channels = [
          {
            plugin: createPlugin("demo-beta"),
            pluginId: "demo-beta",
            source: "test",
          },
        ] as typeof registry.channels;
        setActivePluginRegistry(registry, "registry-test");

        expectListedChannelPluginIds(["demo-beta"]);
      },
    },
  ] as const)("$name", ({ run }) => {
    expectRegistryActivationCase(run);
  });
});
