import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
  registerVirtualTestPlugin,
} from "../../test/helpers/plugins/contracts-testkit.js";
import { clearMemoryEmbeddingProviders } from "./memory-embedding-providers.js";
import {
  _resetMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryRuntime,
} from "./memory-state.js";
import { createPluginRecord } from "./status.test-helpers.js";

afterEach(() => {
  _resetMemoryPluginState();
  clearMemoryEmbeddingProviders();
});

function createStubMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return { error: "missing", manager: null } as const;
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

describe("dual-kind memory registration gate", () => {
  it("blocks memory runtime registration for dual-kind plugins not selected for memory slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      config,
      id: "dual-plugin",
      kind: ["memory", "context-engine"],
      name: "Dual Plugin",
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
      registry,
    });

    expect(getMemoryRuntime()).toBeUndefined();
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("dual-kind plugin not selected for memory slot"),
          pluginId: "dual-plugin",
        }),
      ]),
    );
  });

  it("allows memory runtime registration for dual-kind plugins selected for memory slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      config,
      record: createPluginRecord({
        id: "dual-plugin",
        kind: ["memory", "context-engine"],
        memorySlotSelected: true,
        name: "Dual Plugin",
      }),
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
      registry,
    });

    expect(getMemoryRuntime()).toBeDefined();
    expect(
      registry.registry.diagnostics.filter(
        (d) => d.pluginId === "dual-plugin" && d.level === "warn",
      ),
    ).toHaveLength(0);
  });

  it("allows memory runtime registration for single-kind memory plugins without memorySlotSelected", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      config,
      id: "memory-only",
      kind: "memory",
      name: "Memory Only",
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
      registry,
    });

    expect(getMemoryRuntime()).toBeDefined();
  });

  it("allows selected dual-kind plugins to register the unified memory capability", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      config,
      record: createPluginRecord({
        id: "dual-plugin",
        kind: ["memory", "context-engine"],
        memorySlotSelected: true,
        name: "Dual Plugin",
      }),
      register(api) {
        api.registerMemoryCapability({
          promptBuilder: () => ["memory capability"],
          runtime: createStubMemoryRuntime(),
        });
      },
      registry,
    });

    expect(getMemoryCapabilityRegistration()).toMatchObject({
      pluginId: "dual-plugin",
    });
    expect(getMemoryRuntime()).toBeDefined();
  });
});
