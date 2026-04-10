import { loadConfig } from "../../config/config.js";
import { stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";
import { defaultRuntime } from "../../runtime.js";
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
import type { SandboxConfig } from "./types.js";

let lastPruneAtMs = 0;

type PruneableRegistryEntry = Pick<
  SandboxRegistryEntry,
  "containerName" | "backendId" | "createdAtMs" | "lastUsedAtMs"
>;

function shouldPruneSandboxEntry(cfg: SandboxConfig, now: number, entry: PruneableRegistryEntry) {
  const { idleHours } = cfg.prune;
  const { maxAgeDays } = cfg.prune;
  if (idleHours === 0 && maxAgeDays === 0) {
    return false;
  }
  const idleMs = now - entry.lastUsedAtMs;
  const ageMs = now - entry.createdAtMs;
  return (
    (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
    (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
  );
}

async function pruneSandboxRegistryEntries<TEntry extends SandboxRegistryEntry>(params: {
  cfg: SandboxConfig;
  read: () => Promise<{ entries: TEntry[] }>;
  remove: (containerName: string) => Promise<void>;
  removeRuntime: (entry: TEntry) => Promise<void>;
  onRemoved?: (entry: TEntry) => Promise<void>;
}) {
  const now = Date.now();
  if (params.cfg.prune.idleHours === 0 && params.cfg.prune.maxAgeDays === 0) {
    return;
  }
  const registry = await params.read();
  for (const entry of registry.entries) {
    if (!shouldPruneSandboxEntry(params.cfg, now, entry)) {
      continue;
    }
    try {
      await params.removeRuntime(entry);
    } catch {
      // Ignore prune failures
    } finally {
      await params.remove(entry.containerName);
      await params.onRemoved?.(entry);
    }
  }
}

async function pruneSandboxContainers(cfg: SandboxConfig) {
  const config = loadConfig();
  await pruneSandboxRegistryEntries<SandboxRegistryEntry>({
    cfg,
    read: readRegistry,
    remove: removeRegistryEntry,
    removeRuntime: async (entry) => {
      const manager = getSandboxBackendManager(entry.backendId ?? "docker");
      await manager?.removeRuntime({
        config,
        entry,
      });
    },
  });
}

async function pruneSandboxBrowsers(cfg: SandboxConfig) {
  const config = loadConfig();
  await pruneSandboxRegistryEntries<
    SandboxBrowserRegistryEntry & {
      backendId?: string;
      runtimeLabel?: string;
      configLabelKind?: string;
    }
  >({
    cfg,
    onRemoved: async (entry) => {
      const bridge = BROWSER_BRIDGES.get(entry.sessionKey);
      if (bridge?.containerName === entry.containerName) {
        await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
        BROWSER_BRIDGES.delete(entry.sessionKey);
      }
    },
    read: readBrowserRegistry,
    remove: removeBrowserRegistryEntry,
    removeRuntime: async (entry) => {
      await dockerSandboxBackendManager.removeRuntime({
        config,
        entry: {
          ...entry,
          backendId: "docker",
          configLabelKind: "Image",
          runtimeLabel: entry.containerName,
        },
      });
    },
  });
}

export async function maybePruneSandboxes(cfg: SandboxConfig) {
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) {
    return;
  }
  lastPruneAtMs = now;
  try {
    await pruneSandboxContainers(cfg);
    await pruneSandboxBrowsers(cfg);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    defaultRuntime.error?.(`Sandbox prune failed: ${message ?? "unknown error"}`);
  }
}
