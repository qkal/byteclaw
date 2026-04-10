import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const OPENAI_CODEX_MODEL = {
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  contextWindow: 1_050_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "gpt-5.4",
  input: ["text"],
  maxTokens: 128_000,
  name: "GPT-5.4",
  provider: "openai-codex",
};

const OPENAI_CODEX_MINI_MODEL = {
  ...OPENAI_CODEX_MODEL,
  contextWindow: 272_000,
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
};

const OPENAI_CODEX_53_MODEL = {
  ...OPENAI_CODEX_MODEL,
  id: "gpt-5.4",
  name: "GPT-5.3 Codex",
};

const mocks = vi.hoisted(() => {
  const sourceConfig = {
    agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
    models: {
      providers: {
        openai: {
          apiKey: "$OPENAI_API_KEY", // Pragma: allowlist secret
        },
      },
    },
  };
  const resolvedConfig = {
    agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
    models: {
      providers: {
        openai: {
          apiKey: "sk-resolved-runtime-value", // Pragma: allowlist secret
        },
      },
    },
  };
  return {
    ensureAuthProfileStore: vi.fn(),
    ensureOpenClawModelsJson: vi.fn(),
    listProfilesForProvider: vi.fn(),
    loadModelCatalog: vi.fn(),
    loadModelRegistry: vi.fn(),
    loadModelsConfigWithSource: vi.fn(),
    printModelTable: vi.fn(),
    resolveConfiguredEntries: vi.fn(),
    resolveModelWithRegistry: vi.fn(),
    resolvedConfig,
    sourceConfig,
  };
});

function resetMocks() {
  mocks.loadModelsConfigWithSource.mockResolvedValue({
    diagnostics: [],
    resolvedConfig: mocks.resolvedConfig,
    sourceConfig: mocks.sourceConfig,
  });
  mocks.ensureOpenClawModelsJson.mockResolvedValue({ wrote: false });
  mocks.ensureAuthProfileStore.mockReturnValue({ order: {}, profiles: {}, version: 1 });
  mocks.loadModelRegistry.mockResolvedValue({
    availableKeys: new Set(),
    models: [],
    registry: {
      getAll: () => [],
    },
  });
  mocks.loadModelCatalog.mockResolvedValue([]);
  mocks.resolveConfiguredEntries.mockReturnValue({
    entries: [
      {
        aliases: [],
        key: "openai-codex/gpt-5.4",
        ref: { model: "gpt-5.4", provider: "openai-codex" },
        tags: new Set(["configured"]),
      },
    ],
  });
  mocks.printModelTable.mockReset();
  mocks.listProfilesForProvider.mockReturnValue([]);
  mocks.resolveModelWithRegistry.mockReturnValue({ ...OPENAI_CODEX_MODEL });
}

function createRuntime() {
  return { error: vi.fn(), log: vi.fn() };
}

function lastPrintedRows<T>() {
  return (mocks.printModelTable.mock.calls.at(-1)?.[0] ?? []) as T[];
}

let modelsListCommand: typeof import("./list.list-command.js").modelsListCommand;
let listRowsModule: typeof import("./list.rows.js");
let listRegistryModule: typeof import("./list.registry.js");

function installModelsListCommandForwardCompatMocks() {
  vi.doMock("../../agents/model-suppression.js", () => ({
    shouldSuppressBuiltInModel: ({
      provider,
      id,
    }: {
      provider?: string | null;
      id?: string | null;
    }) =>
      (provider === "openai" || provider === "azure-openai-responses") &&
      id === "gpt-5.3-codex-spark",
  }));

  vi.doMock("./load-config.js", () => ({
    loadModelsConfigWithSource: mocks.loadModelsConfigWithSource,
  }));

  vi.doMock("./list.configured.js", () => ({
    resolveConfiguredEntries: mocks.resolveConfiguredEntries,
  }));

  vi.doMock("./list.table.js", () => ({
    printModelTable: mocks.printModelTable,
  }));

  vi.doMock("./list.runtime.js", () => ({
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    ensureOpenClawModelsJson: mocks.ensureOpenClawModelsJson,
    hasUsableCustomProviderApiKey: vi.fn().mockReturnValue(false),
    listProfilesForProvider: mocks.listProfilesForProvider,
    loadModelCatalog: mocks.loadModelCatalog,
    resolveAwsSdkEnvVarName: vi.fn().mockReturnValue(undefined),
    resolveEnvApiKey: vi.fn().mockReturnValue(undefined),
    resolveModelWithRegistry: mocks.resolveModelWithRegistry,
  }));
}

beforeAll(async () => {
  installModelsListCommandForwardCompatMocks();
  listRowsModule = await import("./list.rows.js");
  listRegistryModule = await import("./list.registry.js");
  vi.spyOn(listRegistryModule, "loadModelRegistry").mockImplementation(mocks.loadModelRegistry);
  ({ modelsListCommand } = await import("./list.list-command.js"));
});

async function buildAllOpenAiCodexRows(opts: { supplementCatalog?: boolean } = {}) {
  const loaded = await mocks.loadModelRegistry();
  const rows: unknown[] = [];
  const context = {
    authStore: mocks.ensureAuthProfileStore(),
    availableKeys: loaded.availableKeys,
    cfg: mocks.resolvedConfig,
    configuredByKey: new Map(),
    discoveredKeys: new Set(
      loaded.models.map(
        (model: { provider: string; id: string }) => `${model.provider}/${model.id}`,
      ),
    ),
    filter: { provider: "openai-codex" },
  };
  const seenKeys = listRowsModule.appendDiscoveredRows({
    context: context as never,
    models: loaded.models as never,
    rows: rows as never,
  });
  if (opts.supplementCatalog !== false) {
    await listRowsModule.appendCatalogSupplementRows({
      context: context as never,
      modelRegistry: loaded.registry as never,
      rows: rows as never,
      seenKeys,
    });
  }
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
});

describe("modelsListCommand forward-compat", () => {
  describe("configured rows", () => {
    it("does not mark configured codex model as missing when forward-compat can build a fallback", async () => {
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      const rows = lastPrintedRows<{
        key: string;
        tags: string[];
        missing: boolean;
      }>();

      const codex = rows.find((row) => row.key === "openai-codex/gpt-5.4");
      expect(codex).toBeTruthy();
      expect(codex?.missing).toBe(false);
      expect(codex?.tags).not.toContain("missing");
    });

    it("does not mark configured codex mini as missing when forward-compat can build a fallback", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            aliases: [],
            key: "openai-codex/gpt-5.4-mini",
            ref: { model: "gpt-5.4-mini", provider: "openai-codex" },
            tags: new Set(["configured"]),
          },
        ],
      });
      mocks.resolveModelWithRegistry.mockReturnValueOnce({ ...OPENAI_CODEX_MINI_MODEL });
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      const rows = lastPrintedRows<{
        key: string;
        tags: string[];
        missing: boolean;
      }>();

      const codexMini = rows.find((row) => row.key === "openai-codex/gpt-5.4-mini");
      expect(codexMini).toBeTruthy();
      expect(codexMini?.missing).toBe(false);
      expect(codexMini?.tags).not.toContain("missing");
    });

    it("passes source config to model registry loading for persistence safety", async () => {
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledWith(mocks.resolvedConfig, {
        sourceConfig: mocks.sourceConfig,
      });
    });

    it("keeps configured local openai gpt-5.4 entries visible in --local output", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            aliases: [],
            key: "openai/gpt-5.4",
            ref: { model: "gpt-5.4", provider: "openai" },
            tags: new Set(["configured"]),
          },
        ],
      });
      mocks.resolveModelWithRegistry.mockReturnValueOnce({
        api: "openai-responses",
        baseUrl: "http://localhost:4000/v1",
        contextWindow: 1_050_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.4",
        input: ["text", "image"],
        maxTokens: 128_000,
        name: "GPT-5.4",
        provider: "openai",
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true, local: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "openai/gpt-5.4",
        }),
      ]);
    });
  });

  describe("availability fallback", () => {
    it("marks synthetic codex gpt-5.4 rows as available when provider auth exists", async () => {
      mocks.listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
        provider === "openai-codex"
          ? ([{ id: "profile-1" }] as Record<string, unknown>[])
          : [],
      );
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string; available: boolean }>()).toContainEqual(
        expect.objectContaining({
          available: true,
          key: "openai-codex/gpt-5.4",
        }),
      );
    });

    it("exits with an error when configured-mode listing has no model registry", async () => {
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      mocks.loadModelRegistry.mockResolvedValueOnce({
        availableKeys: new Set<string>(),
        models: [],
        registry: undefined,
      });
      const runtime = createRuntime();
      let observedExitCode: number | undefined;

      try {
        await modelsListCommand({ json: true }, runtime as never);
        observedExitCode = process.exitCode;
      } finally {
        process.exitCode = previousExitCode;
      }

      expect(runtime.error).toHaveBeenCalledWith("Model registry unavailable.");
      expect(observedExitCode).toBe(1);
      expect(mocks.printModelTable).not.toHaveBeenCalled();
    });
  });

  describe("--all catalog supplementation", () => {
    it("includes synthetic codex gpt-5.4 in --all output when catalog supports it", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelRegistry.mockResolvedValueOnce({
        availableKeys: new Set(["openai-codex/gpt-5.4"]),
        models: [],
        registry: {
          getAll: () => [],
        },
      });
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          contextWindow: 400_000,
          id: "gpt-5.4",
          input: ["text"],
          name: "GPT-5.3 Codex",
          provider: "openai-codex",
        },
      ]);
      mocks.listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
        provider === "openai-codex"
          ? ([{ id: "profile-1" }] as Record<string, unknown>[])
          : [],
      );
      mocks.resolveModelWithRegistry.mockImplementation(
        ({ provider, modelId }: { provider: string; modelId: string }) => {
          if (provider !== "openai-codex") {
            return undefined;
          }
          if (modelId === "gpt-5.4") {
            return { ...OPENAI_CODEX_53_MODEL };
          }
          return undefined;
        },
      );
      mocks.resolveModelWithRegistry.mockImplementationOnce(
        ({ provider, modelId }: { provider: string; modelId: string }) =>
          provider === "openai-codex" && modelId === "gpt-5.4"
            ? { ...OPENAI_CODEX_53_MODEL }
            : undefined,
      );
      const rows = await buildAllOpenAiCodexRows();
      expect(rows).toEqual([
        expect.objectContaining({
          available: true,
          key: "openai-codex/gpt-5.4",
        }),
      ]);
    });

    it("suppresses direct openai gpt-5.3-codex-spark rows in --all output", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      const rows: unknown[] = [];
      listRowsModule.appendDiscoveredRows({
        context: {
          authStore: mocks.ensureAuthProfileStore(),
          availableKeys: new Set(["openai-codex/gpt-5.4"]),
          cfg: mocks.resolvedConfig,
          configuredByKey: new Map(),
          discoveredKeys: new Set(),
          filter: {},
        } as never,
        models: [
          {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            contextWindow: 128000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "gpt-5.3-codex-spark",
            input: ["text", "image"],
            maxTokens: 32000,
            name: "GPT-5.3 Codex Spark",
            provider: "openai",
          },
          {
            api: "azure-openai-responses",
            baseUrl: "https://example.openai.azure.com/openai/v1",
            contextWindow: 128000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "gpt-5.3-codex-spark",
            input: ["text", "image"],
            maxTokens: 32000,
            name: "GPT-5.3 Codex Spark",
            provider: "azure-openai-responses",
          },
          { ...OPENAI_CODEX_53_MODEL },
        ] as never,
        rows: rows as never,
      });

      expect(rows).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
        }),
      ]);
    });
  });

  describe("provider filter canonicalization", () => {
    it("matches alias-valued discovered providers against canonical provider filters", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelRegistry.mockResolvedValueOnce({
        availableKeys: new Set(["z.ai/glm-4.5"]),
        models: [
          {
            api: "openai-responses",
            baseUrl: "https://api.z.ai/v1",
            contextWindow: 128_000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "glm-4.5",
            input: ["text"],
            maxTokens: 16_384,
            name: "GLM-4.5",
            provider: "z.ai",
          },
        ],
        registry: {
          getAll: () => [
            {
              api: "openai-responses",
              baseUrl: "https://api.z.ai/v1",
              contextWindow: 128_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "glm-4.5",
              input: ["text"],
              maxTokens: 16_384,
              name: "GLM-4.5",
              provider: "z.ai",
            },
          ],
        },
      });

      const runtime = createRuntime();

      await modelsListCommand({ all: true, json: true, provider: "z-ai" }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "z.ai/glm-4.5",
        }),
      ]);
    });
  });
});
