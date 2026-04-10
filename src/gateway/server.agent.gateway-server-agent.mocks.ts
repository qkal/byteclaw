import { vi } from "vitest";
import { type PluginRegistry, createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

export const registryState: { registry: PluginRegistry } = {
  registry: createEmptyPluginRegistry(),
};

export function setRegistry(registry: PluginRegistry) {
  registryState.registry = registry;
  setTestPluginRegistry(registry);
  setActivePluginRegistry(registry);
}

vi.mock("./server-plugins.js", async () => {
  const actual = await vi.importActual<typeof import("./server-plugins.js")>("./server-plugins.js");
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");
  return {
    ...actual,
    loadGatewayPlugins: (params: { baseMethods: string[] }) => {
      setActivePluginRegistry(registryState.registry);
      return {
        gatewayMethods: params.baseMethods ?? [],
        pluginRegistry: registryState.registry,
      };
    },
    setFallbackGatewayContextResolver: vi.fn(),
  };
});
