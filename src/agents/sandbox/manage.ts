import { loadConfig } from "../../config/config.js";
import { stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";
import { getSandboxBackendManager } from "./backend.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import {
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
} from "./registry.js";
import { resolveSandboxAgentId } from "./shared.js";

export type SandboxContainerInfo = SandboxRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

export type SandboxBrowserInfo = SandboxBrowserRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

function toBrowserDockerRuntimeEntry(entry: SandboxBrowserRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: "docker",
    configLabelKind: "BrowserImage",
    runtimeLabel: entry.containerName,
  };
}

export async function listSandboxContainers(): Promise<SandboxContainerInfo[]> {
  const config = loadConfig();
  const registry = await readRegistry();
  const results: SandboxContainerInfo[] = [];

  for (const entry of registry.entries) {
    const backendId = entry.backendId ?? "docker";
    const manager = getSandboxBackendManager(backendId);
    if (!manager) {
      results.push({
        ...entry,
        imageMatch: true,
        running: false,
      });
      continue;
    }
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const runtime = await manager.describeRuntime({
      agentId,
      config,
      entry,
    });
    results.push({
      ...entry,
      image: runtime.actualConfigLabel ?? entry.image,
      imageMatch: runtime.configLabelMatch,
      running: runtime.running,
    });
  }

  return results;
}

export async function listSandboxBrowsers(): Promise<SandboxBrowserInfo[]> {
  const config = loadConfig();
  const registry = await readBrowserRegistry();
  const results: SandboxBrowserInfo[] = [];

  for (const entry of registry.entries) {
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const runtime = await dockerSandboxBackendManager.describeRuntime({
      agentId,
      config,
      entry: toBrowserDockerRuntimeEntry(entry),
    });
    results.push({
      ...entry,
      image: runtime.actualConfigLabel ?? entry.image,
      imageMatch: runtime.configLabelMatch,
      running: runtime.running,
    });
  }

  return results;
}

export async function removeSandboxContainer(containerName: string): Promise<void> {
  const config = loadConfig();
  const registry = await readRegistry();
  const entry = registry.entries.find((item) => item.containerName === containerName);
  if (entry) {
    const manager = getSandboxBackendManager(entry.backendId ?? "docker");
    await manager?.removeRuntime({
      agentId: resolveSandboxAgentId(entry.sessionKey),
      config,
      entry,
    });
  }
  await removeRegistryEntry(containerName);
}

export async function removeSandboxBrowserContainer(containerName: string): Promise<void> {
  const config = loadConfig();
  const registry = await readBrowserRegistry();
  const entry = registry.entries.find((item) => item.containerName === containerName);
  if (entry) {
    await dockerSandboxBackendManager.removeRuntime({
      config,
      entry: toBrowserDockerRuntimeEntry(entry),
    });
  }
  await removeBrowserRegistryEntry(containerName);

  for (const [sessionKey, bridge] of BROWSER_BRIDGES.entries()) {
    if (bridge.containerName === containerName) {
      await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
      BROWSER_BRIDGES.delete(sessionKey);
    }
  }
}
