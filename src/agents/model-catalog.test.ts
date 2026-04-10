import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";

type PiSdkModule = typeof import("./pi-model-discovery.js");

let __setModelCatalogImportForTest: typeof import("./model-catalog.js").__setModelCatalogImportForTest;
let findModelInCatalog: typeof import("./model-catalog.js").findModelInCatalog;
let loadModelCatalog: typeof import("./model-catalog.js").loadModelCatalog;
let resetModelCatalogCacheForTest: typeof import("./model-catalog.js").resetModelCatalogCacheForTest;
let augmentCatalogMock: ReturnType<typeof vi.fn>;

vi.mock("./model-suppression.runtime.js", () => ({
  shouldSuppressBuiltInModel: (params: { provider?: string; id?: string }) =>
    (params.provider === "openai" || params.provider === "azure-openai-responses") &&
    params.id === "gpt-5.3-codex-spark",
}));

function mockCatalogImportFailThenRecover() {
  let call = 0;
  __setModelCatalogImportForTest(async () => {
    call += 1;
    if (call === 1) {
      throw new Error("boom");
    }
    return {
      AuthStorage: class {},
      ModelRegistry: class {
        getAll() {
          return [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }];
        }
      },
      discoverAuthStorage: () => ({}),
    } as unknown as PiSdkModule;
  });
  return () => call;
}

function mockPiDiscoveryModels(models: unknown[]) {
  __setModelCatalogImportForTest(
    async () =>
      ({
        AuthStorage: class {},
        ModelRegistry: class {
          getAll() {
            return models;
          }
        },
        discoverAuthStorage: () => ({}),
      }) as unknown as PiSdkModule,
  );
}

function mockSingleOpenAiCatalogModel() {
  mockPiDiscoveryModels([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
}

describe("loadModelCatalog", () => {
  beforeAll(async () => {
    vi.doMock("./models-config.js", () => ({
      ensureOpenClawModelsJson: vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false }),
    }));
    vi.doMock("./agent-paths.js", () => ({
      resolveOpenClawAgentDir: () => "/tmp/openclaw",
    }));
    vi.doMock("../plugins/provider-runtime.runtime.js", () => ({
      augmentModelCatalogWithProviderPlugins: vi.fn().mockResolvedValue([]),
    }));

    ({
      __setModelCatalogImportForTest,
      findModelInCatalog,
      loadModelCatalog,
      resetModelCatalogCacheForTest,
    } = await import("./model-catalog.js"));
    const providerRuntime = await import("../plugins/provider-runtime.runtime.js");
    augmentCatalogMock = vi.mocked(providerRuntime.augmentModelCatalogWithProviderPlugins);
  });

  beforeEach(() => {
    resetModelCatalogCacheForTest();
  });

  afterEach(() => {
    __setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./models-config.js");
    vi.doUnmock("./agent-paths.js");
    vi.doUnmock("../plugins/provider-runtime.runtime.js");
  });

  it("retries after import failure without poisoning the cache", async () => {
    setLoggerOverride({ consoleLevel: "warn", level: "silent" });
    try {
      const getCallCount = mockCatalogImportFailThenRecover();

      const cfg = {} as OpenClawConfig;
      const first = await loadModelCatalog({ config: cfg });
      expect(first).toEqual([]);

      const second = await loadModelCatalog({ config: cfg });
      expect(second).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
      expect(getCallCount()).toBe(2);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("returns partial results on discovery errors", async () => {
    setLoggerOverride({ consoleLevel: "warn", level: "silent" });
    try {
      __setModelCatalogImportForTest(
        async () =>
          ({
            AuthStorage: class {},
            ModelRegistry: class {
              getAll() {
                return [
                  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
                  {
                    get id() {
                      throw new Error("boom");
                    },
                    name: "bad",
                    provider: "openai",
                  },
                ];
              }
            },
            discoverAuthStorage: () => ({}),
          }) as unknown as PiSdkModule,
      );

      const result = await loadModelCatalog({ config: {} as OpenClawConfig });
      expect(result).toEqual([{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }]);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("does not synthesize stale openai-codex/gpt-5.3-codex-spark entries from gpt-5.4", async () => {
    mockPiDiscoveryModels([
      {
        contextWindow: 200_000,
        id: "gpt-5.4",
        input: ["text"],
        name: "GPT-5.3 Codex",
        provider: "openai-codex",
        reasoning: true,
      },
      {
        id: "gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        provider: "openai-codex",
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(result).not.toContainEqual(
      expect.objectContaining({
        id: "gpt-5.3-codex-spark",
        provider: "openai-codex",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.4",
        name: "GPT-5.3 Codex",
        provider: "openai-codex",
      }),
    );
  });

  it("filters stale openai gpt-5.3-codex-spark built-ins from the catalog", async () => {
    mockPiDiscoveryModels([
      {
        contextWindow: 128_000,
        id: "gpt-5.3-codex-spark",
        input: ["text", "image"],
        name: "GPT-5.3 Codex Spark",
        provider: "openai",
        reasoning: true,
      },
      {
        contextWindow: 128_000,
        id: "gpt-5.3-codex-spark",
        input: ["text", "image"],
        name: "GPT-5.3 Codex Spark",
        provider: "azure-openai-responses",
        reasoning: true,
      },
      {
        contextWindow: 128_000,
        id: "gpt-5.3-codex-spark",
        input: ["text"],
        name: "GPT-5.3 Codex Spark",
        provider: "openai-codex",
        reasoning: true,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });
    expect(result).not.toContainEqual(
      expect.objectContaining({
        id: "gpt-5.3-codex-spark",
        provider: "openai",
      }),
    );
    expect(result).not.toContainEqual(
      expect.objectContaining({
        id: "gpt-5.3-codex-spark",
        provider: "azure-openai-responses",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.3-codex-spark",
        provider: "openai-codex",
      }),
    );
  });

  it("does not synthesize gpt-5.4 OpenAI forward-compat entries from template models", async () => {
    mockPiDiscoveryModels([
      {
        contextWindow: 1_050_000,
        id: "gpt-5.2",
        input: ["text", "image"],
        name: "GPT-5.2",
        provider: "openai",
        reasoning: true,
      },
      {
        contextWindow: 1_050_000,
        id: "gpt-5.2-pro",
        input: ["text", "image"],
        name: "GPT-5.2 Pro",
        provider: "openai",
        reasoning: true,
      },
      {
        contextWindow: 400_000,
        id: "gpt-5-mini",
        input: ["text", "image"],
        name: "GPT-5 mini",
        provider: "openai",
        reasoning: true,
      },
      {
        contextWindow: 400_000,
        id: "gpt-5-nano",
        input: ["text", "image"],
        name: "GPT-5 nano",
        provider: "openai",
        reasoning: true,
      },
      {
        contextWindow: 272_000,
        id: "gpt-5.4",
        input: ["text", "image"],
        name: "GPT-5.3 Codex",
        provider: "openai-codex",
        reasoning: true,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(
      result.some((entry) => entry.provider === "openai" && entry.id.startsWith("gpt-5.4")),
    ).toBe(false);
    expect(result).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.4",
        name: "GPT-5.3 Codex",
        provider: "openai-codex",
      }),
    );
    expect(
      result.some((entry) => entry.provider === "openai-codex" && entry.id === "gpt-5.4-mini"),
    ).toBe(false);
  });

  it("merges provider-owned supplemental catalog entries", async () => {
    mockSingleOpenAiCatalogModel();
    augmentCatalogMock.mockResolvedValueOnce([
      {
        contextWindow: 1_048_576,
        id: "google/gemini-3-pro-preview",
        input: ["text", "image"],
        name: "Gemini 3 Pro Preview",
        provider: "kilocode",
        reasoning: true,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toContainEqual(
      expect.objectContaining({
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
        provider: "kilocode",
      }),
    );
  });

  it("dedupes supplemental models against registry entries", async () => {
    mockSingleOpenAiCatalogModel();
    augmentCatalogMock.mockResolvedValueOnce([
      {
        contextWindow: 1_048_576,
        id: "llama3.2",
        input: ["text"],
        name: "Llama 3.2",
        provider: "ollama",
        reasoning: true,
      },
      {
        id: "gpt-4.1",
        name: "Duplicate GPT-4.1",
        provider: "openai",
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(result).toContainEqual(
      expect.objectContaining({ id: "llama3.2", name: "Llama 3.2", provider: "ollama" }),
    );
    expect(
      result.filter((entry) => entry.provider === "openai" && entry.id === "gpt-4.1"),
    ).toHaveLength(1);
  });

  it("does not add unrelated models when provider plugins return nothing", async () => {
    mockSingleOpenAiCatalogModel();

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    expect(
      result.some((entry) => entry.provider === "qianfan" && entry.id === "deepseek-v3.2"),
    ).toBe(false);
  });

  it("does not duplicate provider-owned supplemental models already present in ModelRegistry", async () => {
    mockPiDiscoveryModels([
      {
        id: "kilo/auto",
        name: "Kilo Auto",
        provider: "kilocode",
      },
    ]);
    augmentCatalogMock.mockResolvedValueOnce([
      {
        contextWindow: 1_000_000,
        id: "kilo/auto",
        input: ["text", "image"],
        name: "Configured Kilo Auto",
        provider: "kilocode",
        reasoning: true,
      },
    ]);

    const result = await loadModelCatalog({ config: {} as OpenClawConfig });

    const matches = result.filter(
      (entry) => entry.provider === "kilocode" && entry.id === "kilo/auto",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Kilo Auto");
  });

  it("matches models across canonical provider aliases", () => {
    expect(
      findModelInCatalog([{ id: "glm-5", name: "GLM-5", provider: "z.ai" }], "z-ai", "glm-5"),
    ).toEqual({
      id: "glm-5",
      name: "GLM-5",
      provider: "z.ai",
    });
  });
});
