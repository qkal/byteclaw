import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface DiscoveredModel { id: string; contextWindow?: number; contextTokens?: number }
type ContextModule = typeof import("./context.js");

const contextTestState = vi.hoisted(() => {
  const state = {
    discoverAuthStorage: vi.fn(() => ({})),
    discoverModels: vi.fn(() => ({
      getAll: () => state.discoveredModels,
    })),
    discoveredModels: [] as DiscoveredModel[],
    ensureOpenClawModelsJson: vi.fn(async () => {}),
    loadConfigImpl: () => ({}) as unknown,
  };
  return state;
});

vi.mock("../config/config.js", () => ({
  loadConfig: () => contextTestState.loadConfigImpl(),
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: contextTestState.ensureOpenClawModelsJson,
}));

vi.mock("./agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
}));

vi.mock("./pi-model-discovery-runtime.js", () => ({
  discoverAuthStorage: contextTestState.discoverAuthStorage,
  discoverModels: contextTestState.discoverModels,
}));

function mockContextDeps(params: {
  loadConfig: () => unknown;
  discoveredModels?: DiscoveredModel[];
}) {
  contextTestState.loadConfigImpl = params.loadConfig;
  contextTestState.discoveredModels = params.discoveredModels ?? [];
  contextTestState.ensureOpenClawModelsJson.mockClear();
  return { ensureOpenClawModelsJson: contextTestState.ensureOpenClawModelsJson };
}

function mockContextModuleDeps(loadConfigImpl: () => unknown) {
  return mockContextDeps({ loadConfig: loadConfigImpl });
}

// Shared mock setup used by multiple tests.
function mockDiscoveryDeps(
  models: DiscoveredModel[],
  configModels?: Record<string, { models: { id: string; contextWindow: number }[] }>,
) {
  mockContextDeps({
    discoveredModels: models,
    loadConfig: () => ({ models: configModels ? { providers: configModels } : {} }),
  });
}

function createContextOverrideConfig(provider: string, model: string, contextWindow: number) {
  return {
    models: {
      providers: {
        [provider]: {
          models: [{ contextWindow, id: model }],
        },
      },
    },
  };
}

async function flushAsyncWarmup() {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await new Promise((r) => setTimeout(r, 0));
}

let contextModule: ContextModule;

async function importContextModule(): Promise<ContextModule> {
  await flushAsyncWarmup();
  return contextModule;
}

async function importFreshContextModule(): Promise<ContextModule> {
  vi.resetModules();
  const module = await import("./context.js");
  await flushAsyncWarmup();
  return module;
}

async function importResolveContextTokensForModel() {
  const { resolveContextTokensForModel } = await importContextModule();
  return resolveContextTokensForModel;
}

describe("lookupContextTokens", () => {
  beforeAll(async () => {
    contextModule = await import("./context.js");
  });

  beforeEach(() => {
    contextTestState.loadConfigImpl = () => ({});
    contextTestState.discoveredModels = [];
    contextTestState.ensureOpenClawModelsJson.mockClear();
    contextTestState.discoverAuthStorage.mockClear();
    contextTestState.discoverModels.mockClear();
    contextModule.resetContextWindowCacheForTest();
  });

  afterEach(async () => {
    contextModule.resetContextWindowCacheForTest();
    await flushAsyncWarmup();
  });

  it("returns configured model context window on first lookup", async () => {
    mockContextModuleDeps(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ contextWindow: 321_000, id: "openrouter/claude-sonnet" }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await importContextModule();
    expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(321_000);
  });

  it("returns sync config overrides for read-only callers", async () => {
    mockContextModuleDeps(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ contextWindow: 321_000, id: "openrouter/claude-sonnet" }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await importContextModule();
    expect(lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false })).toBe(
      321_000,
    );
  });

  it("prefers config contextTokens over contextWindow on first lookup", async () => {
    mockContextModuleDeps(() => ({
      models: {
        providers: {
          "openai-codex": {
            models: [{ contextTokens: 272_000, contextWindow: 1_050_000, id: "gpt-5.4" }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await importContextModule();
    expect(lookupContextTokens("gpt-5.4", { allowAsyncLoad: false })).toBe(272_000);
  });

  it("rehydrates config-backed cache entries after module reload when runtime config survives", async () => {
    const firstLoadConfigMock = vi.fn(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ contextWindow: 321_000, id: "openrouter/claude-sonnet" }],
          },
        },
      },
    }));
    mockContextModuleDeps(firstLoadConfigMock);

    let { lookupContextTokens } = await importFreshContextModule();
    expect(lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false })).toBe(
      321_000,
    );
    expect(firstLoadConfigMock).toHaveBeenCalledTimes(1);

    vi.resetModules();

    const secondLoadConfigMock = vi.fn(() => {
      throw new Error("config should come from shared runtime state");
    });
    mockContextModuleDeps(secondLoadConfigMock);

    ({ lookupContextTokens } = await importFreshContextModule());
    expect(lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false })).toBe(
      321_000,
    );
    expect(secondLoadConfigMock).not.toHaveBeenCalled();
  });

  it("only warms eagerly for real openclaw startup commands that need model metadata", async () => {
    const argvSnapshot = process.argv;
    try {
      for (const scenario of [
        {
          argv: ["node", "openclaw", "chat"],
          expectedCalls: 1,
        },
        {
          argv: ["node", "openclaw", "--profile", "--", "config", "validate"],
          expectedCalls: 0,
        },
        {
          argv: ["node", "openclaw", "logs", "--limit", "5"],
          expectedCalls: 0,
        },
        {
          argv: ["node", "openclaw", "status", "--json"],
          expectedCalls: 0,
        },
        {
          argv: ["node", "scripts/test-built-plugin-singleton.mjs"],
          expectedCalls: 0,
        },
      ]) {
        const loadConfigMock = vi.fn(() => ({ models: {} }));
        const { ensureOpenClawModelsJson } = mockContextModuleDeps(loadConfigMock);
        process.argv = scenario.argv;
        await importFreshContextModule();
        expect(loadConfigMock).toHaveBeenCalledTimes(scenario.expectedCalls);
        expect(ensureOpenClawModelsJson).toHaveBeenCalledTimes(scenario.expectedCalls);
      }
    } finally {
      process.argv = argvSnapshot;
    }
  });

  it("retries config loading after backoff when an initial load fails", async () => {
    vi.useFakeTimers();
    const loadConfigMock = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("transient");
      })
      .mockImplementation(() => ({
        models: {
          providers: {
            openrouter: {
              models: [{ contextWindow: 654_321, id: "openrouter/claude-sonnet" }],
            },
          },
        },
      }));

    mockContextModuleDeps(loadConfigMock);

    try {
      const { lookupContextTokens } = await importContextModule();
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(654_321);
      expect(loadConfigMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the smaller window when the same bare model id is discovered under multiple providers", async () => {
    mockDiscoveryDeps([
      { contextWindow: 1_048_576, id: "gemini-3.1-pro-preview" },
      { contextWindow: 128_000, id: "gemini-3.1-pro-preview" },
    ]);

    const { lookupContextTokens } = await importContextModule();
    lookupContextTokens("gemini-3.1-pro-preview");
    await flushAsyncWarmup();
    // Conservative minimum: bare-id cache feeds runtime flush/compaction paths.
    expect(lookupContextTokens("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("resolveContextTokensForModel returns discovery value when provider-qualified entry exists in cache", async () => {
    // Registry returns provider-qualified entries (real-world scenario from #35976).
    // When no explicit config override exists, the bare cache lookup hits the
    // Provider-qualified raw discovery entry.
    mockDiscoveryDeps([
      { contextWindow: 128_000, id: "github-copilot/gemini-3.1-pro-preview" },
      { contextWindow: 1_048_576, id: "google-gemini-cli/gemini-3.1-pro-preview" },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    // With provider specified and no config override, bare lookup finds the
    // Provider-qualified discovery entry.
    const result = resolveContextTokensForModel({
      model: "gemini-3.1-pro-preview",
      provider: "google-gemini-cli",
    });
    expect(result).toBe(1_048_576);
  });

  it("resolveContextTokensForModel returns configured override via direct config scan (beats discovery)", async () => {
    // Config has an explicit contextWindow; resolveContextTokensForModel should
    // Return it via direct config scan, preventing collisions with raw discovery
    // Entries. Real callers (status.summary.ts etc.) always pass cfg.
    mockDiscoveryDeps([
      { contextWindow: 1_048_576, id: "google-gemini-cli/gemini-3.1-pro-preview" },
    ]);

    const cfg = createContextOverrideConfig("google-gemini-cli", "gemini-3.1-pro-preview", 200_000);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "gemini-3.1-pro-preview",
      provider: "google-gemini-cli",
    });
    expect(result).toBe(200_000);
  });

  it("resolveContextTokensForModel honors configured overrides when provider keys use mixed case", async () => {
    mockDiscoveryDeps([{ contextWindow: 1_048_576, id: "openrouter/anthropic/claude-sonnet-4-5" }]);

    const cfg = createContextOverrideConfig(" OpenRouter ", "anthropic/claude-sonnet-4-5", 200_000);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "anthropic/claude-sonnet-4-5",
      provider: "openrouter",
    });
    expect(result).toBe(200_000);
  });

  it("resolveContextTokensForModel: config direct scan prevents OpenRouter qualified key collision for Google provider", async () => {
    // When provider is explicitly "google" and cfg has a Google contextWindow
    // Override, the config direct scan returns it before any cache lookup —
    // So the OpenRouter raw "google/gemini-2.5-pro" qualified entry is never hit.
    // Real callers (status.summary.ts) always pass cfg when provider is explicit.
    mockDiscoveryDeps([{ contextWindow: 999_000, id: "google/gemini-2.5-pro" }]);

    const cfg = createContextOverrideConfig("google", "gemini-2.5-pro", 2_000_000);
    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google/gemini-2.5-pro");
    await flushAsyncWarmup();

    // Google with explicit cfg: config direct scan wins before any cache lookup.
    const googleResult = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "gemini-2.5-pro",
      provider: "google",
    });
    expect(googleResult).toBe(2_000_000);

    // OpenRouter provider with slash model id: bare lookup finds the raw entry.
    const openrouterResult = resolveContextTokensForModel({
      model: "google/gemini-2.5-pro",
      provider: "openrouter",
    });
    expect(openrouterResult).toBe(999_000);
  });

  it("resolveContextTokensForModel prefers exact provider key over alias-normalized match", async () => {
    // When both "bedrock" and "amazon-bedrock" exist as config keys (alias pattern),
    // ResolveConfiguredProviderContextWindow must return the exact-key match first,
    // Not the first normalized hit — mirroring pi-embedded-runner/model.ts behaviour.
    mockDiscoveryDeps([]);

    const cfg = {
      models: {
        providers: {
          "amazon-bedrock": { models: [{ contextWindow: 32_000, id: "claude-alias-test" }] },
          bedrock: { models: [{ contextWindow: 128_000, id: "claude-alias-test" }] },
        },
      },
    };

    const { resolveContextTokensForModel } = await importContextModule();

    // Exact key "bedrock" wins over the alias-normalized match "amazon-bedrock".
    const bedrockResult = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "claude-alias-test",
      provider: "bedrock",
    });
    expect(bedrockResult).toBe(128_000);

    // Exact key "amazon-bedrock" wins (no alias lookup needed).
    const canonicalResult = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "claude-alias-test",
      provider: "amazon-bedrock",
    });
    expect(canonicalResult).toBe(32_000);
  });

  it("resolveContextTokensForModel(model-only) does not apply config scan for inferred provider", async () => {
    // Status.ts log-usage fallback calls resolveContextTokensForModel({ model })
    // With no provider. When model = "google/gemini-2.5-pro" (OpenRouter ID),
    // ResolveProviderModelRef infers provider="google". Without the guard,
    // ResolveConfiguredProviderContextWindow would return Google's configured
    // Window and misreport context limits for the OpenRouter session.
    mockDiscoveryDeps([{ contextWindow: 999_000, id: "google/gemini-2.5-pro" }]);

    const cfg = createContextOverrideConfig("google", "gemini-2.5-pro", 2_000_000);
    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google/gemini-2.5-pro");
    await flushAsyncWarmup();

    // Model-only call (no explicit provider) must NOT apply config direct scan.
    // Falls through to bare cache lookup: "google/gemini-2.5-pro" → 999k ✓.
    const modelOnlyResult = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "google/gemini-2.5-pro",
      // No provider
    });
    expect(modelOnlyResult).toBe(999_000);

    // Explicit provider still uses config scan ✓.
    const explicitResult = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "gemini-2.5-pro",
      provider: "google",
    });
    expect(explicitResult).toBe(2_000_000);
  });

  it("resolveContextTokensForModel: qualified key beats bare min when provider is explicit (original #35976 fix)", async () => {
    // Regression: when both "gemini-3.1-pro-preview" (bare, min=128k) AND
    // "google-gemini-cli/gemini-3.1-pro-preview" (qualified, 1M) are in cache,
    // An explicit-provider call must return the provider-specific qualified value,
    // Not the collided bare minimum.
    mockDiscoveryDeps([
      { contextWindow: 128_000, id: "github-copilot/gemini-3.1-pro-preview" },
      { contextWindow: 128_000, id: "gemini-3.1-pro-preview" },
      { contextWindow: 1_048_576, id: "google-gemini-cli/gemini-3.1-pro-preview" },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    // Qualified "google-gemini-cli/gemini-3.1-pro-preview" → 1M wins over
    // Bare "gemini-3.1-pro-preview" → 128k (cross-provider minimum).
    const result = resolveContextTokensForModel({
      model: "gemini-3.1-pro-preview",
      provider: "google-gemini-cli",
    });
    expect(result).toBe(1_048_576);
  });

  it("resolveContextTokensForModel normalizes explicit provider aliases before config lookup", async () => {
    mockDiscoveryDeps([]);

    const cfg = createContextOverrideConfig("z.ai", "glm-5", 256_000);
    const { resolveContextTokensForModel } = await importContextModule();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "glm-5",
      provider: "z-ai",
    });
    expect(result).toBe(256_000);
  });
});
