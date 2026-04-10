import { afterEach, describe, expect, it } from "vitest";
import { __testing, clearPluginLoaderCache, resolveRuntimePluginRegistry } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import {
  getMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  buildMemoryPromptSection,
  getMemoryRuntime,
  listMemoryCorpusSupplements,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSection,
  registerMemoryPromptSupplement,
  registerMemoryRuntime,
  resolveMemoryFlushPlan,
} from "./memory-state.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import type { CreatePluginRuntimeOptions } from "./runtime/index.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

describe("getCompatibleActivePluginRegistry", () => {
  it("reuses the active registry only when the load context cache key matches", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(__testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        workspaceDir: "/tmp/workspace-b",
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: ["demo"],
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        runtimeOptions: undefined,
      }),
    ).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        runtimeOptions: {
          subagent: {} as CreatePluginRuntimeOptions["subagent"],
        },
      }),
    ).toBeUndefined();
  });

  it("does not treat a default-mode active registry as compatible with gateway binding", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default");

    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    ).toBeUndefined();
  });

  it("does not embed activation secrets in the loader cache key", () => {
    const { cacheKey } = __testing.resolvePluginLoadCacheContext({
      activationSourceConfig: {
        channels: {
          telegram: {
            botToken: "secret-token",
            enabled: true,
          },
        },
        plugins: {
          allow: ["telegram"],
        },
      },
      autoEnabledReasons: {
        telegram: ["telegram configured"],
      },
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
    });

    expect(cacheKey).not.toContain("secret-token");
    expect(cacheKey).not.toContain("botToken");
    expect(cacheKey).not.toContain("telegram configured");
  });

  it("falls back to the current active runtime when no compatibility-shaping inputs are supplied", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "startup-registry");

    expect(__testing.getCompatibleActivePluginRegistry()).toBe(registry);
  });

  it("does not reuse the active registry when core gateway method names differ", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      coreGatewayHandlers: {
        "sessions.get": () => undefined,
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(__testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        coreGatewayHandlers: {
          "sessions.get": () => undefined,
          "sessions.list": () => undefined,
        },
      }),
    ).toBeUndefined();
  });
});

describe("resolveRuntimePluginRegistry", () => {
  it("reuses the compatible active registry before attempting a fresh load", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(resolveRuntimePluginRegistry(loadOptions)).toBe(registry);
  });

  it("falls back to the current active runtime when no explicit load context is provided", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "startup-registry");

    expect(resolveRuntimePluginRegistry()).toBe(registry);
  });
});

describe("clearPluginLoaderCache", () => {
  it("resets registered memory plugin registries", () => {
    registerMemoryEmbeddingProvider({
      create: async () => ({ provider: null }),
      id: "stale",
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      get: async () => null,
      search: async () => [],
    });
    registerMemoryPromptSection(() => ["stale memory section"]);
    registerMemoryPromptSupplement("memory-wiki", () => ["stale wiki supplement"]);
    registerMemoryFlushPlanResolver(() => ({
      forceFlushTranscriptBytes: 2,
      prompt: "stale",
      relativePath: "memory/stale.md",
      reserveTokensFloor: 3,
      softThresholdTokens: 1,
      systemPrompt: "stale",
    }));
    registerMemoryRuntime({
      async getMemorySearchManager() {
        return { manager: null };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    });
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "stale memory section",
      "stale wiki supplement",
    ]);
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/stale.md");
    expect(getMemoryRuntime()).toBeDefined();
    expect(getMemoryEmbeddingProvider("stale")).toBeDefined();

    clearPluginLoaderCache();

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(listMemoryCorpusSupplements()).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();
    expect(getMemoryEmbeddingProvider("stale")).toBeUndefined();
  });
});
