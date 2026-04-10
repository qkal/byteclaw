import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";

const { resolveRuntimePluginRegistryMock } = vi.hoisted(() => ({
  resolveRuntimePluginRegistryMock: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: resolveRuntimePluginRegistryMock,
}));

let getImageGenerationProvider: typeof import("./provider-registry.js").getImageGenerationProvider;
let listImageGenerationProviders: typeof import("./provider-registry.js").listImageGenerationProviders;

describe("image-generation provider registry", () => {
  beforeAll(async () => {
    ({ getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js"));
  });

  beforeEach(() => {
    resolveRuntimePluginRegistryMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);
  });

  it("does not load plugins when listing without config", () => {
    expect(listImageGenerationProviders()).toEqual([]);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
  });

  it("uses active plugin providers without loading from disk", () => {
    const registry = createEmptyPluginRegistry();
    registry.imageGenerationProviders.push({
      pluginId: "custom-image",
      pluginName: "Custom Image",
      provider: {
        capabilities: {
          edit: { enabled: false },
          generate: {},
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
        }),
        id: "custom-image",
        label: "Custom Image",
      },
      source: "test",
    });
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    const provider = getImageGenerationProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
  });

  it("ignores prototype-like provider ids and aliases", () => {
    const registry = createEmptyPluginRegistry();
    registry.imageGenerationProviders.push(
      {
        pluginId: "blocked-image",
        pluginName: "Blocked Image",
        provider: {
          aliases: ["constructor", "prototype"],
          capabilities: {
            edit: { enabled: false },
            generate: {},
          },
          generateImage: async () => ({
            images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
          }),
          id: "__proto__",
        },
        source: "test",
      },
      {
        pluginId: "safe-image",
        pluginName: "Safe Image",
        provider: {
          aliases: ["safe-alias", "constructor"],
          capabilities: {
            edit: { enabled: false },
            generate: {},
          },
          generateImage: async () => ({
            images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
          }),
          id: "safe-image",
        },
        source: "test",
      },
    );
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(getImageGenerationProvider("constructor")).toBeUndefined();
    expect(getImageGenerationProvider("safe-alias")?.id).toBe("safe-image");
  });
});
