import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  loadPinnedRuntimeConfig,
  notifyRuntimeConfigWriteListeners,
  registerRuntimeConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

describe("runtime snapshot state", () => {
  afterEach(() => {
    resetRuntimeConfigState();
  });

  it("pins the first successful load in memory until the snapshot is cleared", () => {
    let freshPort = 18_789;
    let loadCount = 0;
    const loadFresh = (): OpenClawConfig => {
      loadCount += 1;
      return { gateway: { port: freshPort } };
    };

    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(18_789);
    expect(loadCount).toBe(1);

    freshPort = 19_001;
    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(18_789);
    expect(loadCount).toBe(1);

    resetRuntimeConfigState();
    expect(loadPinnedRuntimeConfig(loadFresh).gateway?.port).toBe(19_001);
    expect(loadCount).toBe(2);
  });

  it("returns the source snapshot when runtime snapshot is active", () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            apiKey: "sk-runtime-resolved",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    expect(getRuntimeConfigSourceSnapshot()).toEqual(sourceConfig);
  });

  it("clears runtime source snapshot when runtime snapshot is cleared", () => {
    setRuntimeConfigSnapshot({ gateway: { port: 18_789 } }, { gateway: { port: 18_789 } });
    resetRuntimeConfigState();
    expect(getRuntimeConfigSnapshot()).toBeNull();
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
  });

  it("refreshes both snapshots from disk after a write when source + runtime snapshots exist", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn<() => OpenClawConfig>(() => ({
      gateway: { auth: { mode: "token" } },
    }));
    const nextSourceConfig: OpenClawConfig = {
      gateway: { auth: { mode: "token" } },
      models: {
        providers: {
          openai: {
            apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };

    setRuntimeConfigSnapshot(
      {
        models: {
          providers: {
            openai: {
              apiKey: "sk-runtime-resolved",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      nextSourceConfig,
    );

    await finalizeRuntimeSnapshotWrite({
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
      formatRefreshError: (error) => String(error),
      hadBothSnapshots: true,
      hadRuntimeSnapshot: true,
      loadFreshConfig,
      nextSourceConfig,
      notifyCommittedWrite,
    });

    expect(loadFreshConfig).toHaveBeenCalledTimes(1);
    expect(getRuntimeConfigSnapshot()).toEqual({ gateway: { auth: { mode: "token" } } });
    expect(getRuntimeConfigSourceSnapshot()).toEqual(nextSourceConfig);
    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
  });

  it("refreshes a plain runtime snapshot after writes without restoring a source snapshot", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn(() => ({ gateway: { port: 19_002 } }));

    setRuntimeConfigSnapshot({ gateway: { port: 18_789 } });

    await finalizeRuntimeSnapshotWrite({
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
      formatRefreshError: (error) => String(error),
      hadBothSnapshots: false,
      hadRuntimeSnapshot: true,
      loadFreshConfig,
      nextSourceConfig: { gateway: { port: 19_002 } },
      notifyCommittedWrite,
    });

    expect(loadFreshConfig).toHaveBeenCalledTimes(1);
    expect(getRuntimeConfigSnapshot()).toEqual({ gateway: { port: 19_002 } });
    expect(getRuntimeConfigSourceSnapshot()).toBeNull();
    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
  });

  it("keeps the last-known-good runtime snapshot active while specialized refresh is pending", async () => {
    const notifyCommittedWrite = vi.fn();
    const loadFreshConfig = vi.fn<() => OpenClawConfig>(() => ({
      gateway: { auth: { mode: "token" } },
    }));
    let releaseRefresh!: () => void;
    const refreshPending = new Promise<boolean>((resolve) => {
      releaseRefresh = () => resolve(true);
    });

    setRuntimeConfigSnapshot(
      {
        models: {
          providers: {
            openai: {
              apiKey: "sk-runtime-resolved",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      {
        models: {
          providers: {
            openai: {
              apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
    );
    setRuntimeConfigSnapshotRefreshHandler({
      refresh: async ({ sourceConfig }) => {
        expect(sourceConfig.gateway?.auth).toEqual({ mode: "token" });
        expect(getRuntimeConfigSnapshot()?.gateway?.auth).toBeUndefined();
        return await refreshPending;
      },
    });

    const writePromise = finalizeRuntimeSnapshotWrite({
      createRefreshError: (detail, cause) => new Error(detail, { cause }),
      formatRefreshError: (error) => String(error),
      hadBothSnapshots: true,
      hadRuntimeSnapshot: true,
      loadFreshConfig,
      nextSourceConfig: {
        gateway: { auth: { mode: "token" } },
        models: {
          providers: {
            openai: {
              apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      notifyCommittedWrite,
    });

    await Promise.resolve();
    expect(getRuntimeConfigSnapshot()?.gateway?.auth).toBeUndefined();
    expect(loadFreshConfig).not.toHaveBeenCalled();

    releaseRefresh();
    await writePromise;

    expect(notifyCommittedWrite).toHaveBeenCalledTimes(1);
  });

  it("notifies registered write listeners with committed runtime snapshots", () => {
    const seen: { configPath: string; runtimeConfig: OpenClawConfig }[] = [];
    const unsubscribe = registerRuntimeConfigWriteListener((event) => {
      seen.push({
        configPath: event.configPath,
        runtimeConfig: event.runtimeConfig,
      });
    });

    try {
      notifyRuntimeConfigWriteListeners({
        configPath: "/tmp/openclaw.json",
        persistedHash: "abc123",
        runtimeConfig: { gateway: { port: 19_003 } },
        sourceConfig: { gateway: { port: 18_789 } },
        writtenAtMs: 1,
      });
    } finally {
      unsubscribe();
    }

    expect(seen).toEqual([
      {
        configPath: "/tmp/openclaw.json",
        runtimeConfig: { gateway: { port: 19_003 } },
      },
    ]);
  });
});
