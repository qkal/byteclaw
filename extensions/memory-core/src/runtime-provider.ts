import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./memory/index.js";

export const memoryRuntime: MemoryPluginRuntime = {
  async closeAllMemorySearchManagers() {
    await closeAllMemorySearchManagers();
  },
  async getMemorySearchManager(params) {
    const { manager, error } = await getMemorySearchManager(params);
    return {
      error,
      manager,
    };
  },
  resolveMemoryBackendConfig(params) {
    return resolveMemoryBackendConfig(params);
  },
};
