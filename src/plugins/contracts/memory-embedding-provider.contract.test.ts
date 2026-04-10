import { describe, expect, it } from "vitest";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../../test/helpers/plugins/contracts-testkit.js";
import { getRegisteredMemoryEmbeddingProvider } from "../memory-embedding-providers.js";

describe("memory embedding provider registration", () => {
  it("rejects non-memory plugins that did not declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      config,
      id: "not-memory",
      name: "Not Memory",
      register(api) {
        api.registerMemoryEmbeddingProvider({
          create: async () => ({ provider: null }),
          id: "forbidden",
        });
      },
      registry,
    });

    expect(getRegisteredMemoryEmbeddingProvider("forbidden")).toBeUndefined();
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            "plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: forbidden",
          pluginId: "not-memory",
        }),
      ]),
    );
  });

  it("allows non-memory plugins that declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      config,
      contracts: {
        memoryEmbeddingProviders: ["ollama"],
      },
      id: "ollama",
      name: "Ollama",
      register(api) {
        api.registerMemoryEmbeddingProvider({
          create: async () => ({ provider: null }),
          id: "ollama",
        });
      },
      registry,
    });

    expect(getRegisteredMemoryEmbeddingProvider("ollama")).toEqual({
      adapter: expect.objectContaining({ id: "ollama" }),
      ownerPluginId: "ollama",
    });
  });

  it("records the owning memory plugin id for registered adapters", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      config,
      id: "memory-core",
      kind: "memory",
      name: "Memory Core",
      register(api) {
        api.registerMemoryEmbeddingProvider({
          create: async () => ({ provider: null }),
          id: "demo-embedding",
        });
      },
      registry,
    });

    expect(getRegisteredMemoryEmbeddingProvider("demo-embedding")).toEqual({
      adapter: expect.objectContaining({ id: "demo-embedding" }),
      ownerPluginId: "memory-core",
    });
  });
});
