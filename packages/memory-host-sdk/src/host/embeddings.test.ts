import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authModule from "../../../../src/agents/model-auth.js";
import { DEFAULT_GEMINI_EMBEDDING_MODEL } from "./embeddings-gemini.js";
import { DEFAULT_LOCAL_MODEL, createEmbeddingProvider } from "./embeddings.js";
import * as nodeLlamaModule from "./node-llama.js";
import { mockPublicPinnedHostname } from "./test-helpers/ssrf.js";

const { createOllamaEmbeddingProviderMock } = vi.hoisted(() => ({
  createOllamaEmbeddingProviderMock: vi.fn(async () => {
    throw new Error("Unexpected ollama provider in embeddings.test.ts");
  }),
}));

const { hasAwsCredentialsMock } = vi.hoisted(() => ({
  hasAwsCredentialsMock: vi.fn(async () => false),
}));

vi.mock("../../../../src/infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    fetchImpl?: typeof fetch;
  }) => {
    const fetchImpl = params.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("fetch is not available");
    }
    const response = await fetchImpl(params.url, params.init);
    return {
      finalUrl: params.url,
      release: async () => {},
      response,
    };
  },
}));

vi.mock("./embeddings-ollama.js", () => ({
  createOllamaEmbeddingProvider: createOllamaEmbeddingProviderMock,
}));

vi.mock("./embeddings-bedrock.js", async () => {
  const actual =
    await vi.importActual<typeof import("./embeddings-bedrock.js")>("./embeddings-bedrock.js");
  return {
    ...actual,
    hasAwsCredentials: hasAwsCredentialsMock,
  };
});

const createFetchMock = () =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
    ok: true,
    status: 200,
  }));

const createGeminiFetchMock = () =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    json: async () => ({ embedding: { values: [1, 2, 3] } }),
    ok: true,
    status: 200,
  }));

function installFetchMock(fetchMock: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", fetchMock);
}

function readFirstFetchRequest(fetchMock: { mock: { calls: unknown[][] } }) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return { init: init as RequestInit | undefined, url };
}

type ResolvedProviderAuth = Awaited<ReturnType<typeof authModule.resolveApiKeyForProvider>>;

beforeEach(() => {
  vi.spyOn(authModule, "resolveApiKeyForProvider");
  vi.spyOn(nodeLlamaModule, "importNodeLlamaCpp");
});

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function requireProvider(result: Awaited<ReturnType<typeof createEmbeddingProvider>>) {
  if (!result.provider) {
    throw new Error("Expected embedding provider");
  }
  return result.provider;
}

function mockResolvedProviderKey(apiKey = "provider-key") {
  vi.mocked(authModule.resolveApiKeyForProvider).mockResolvedValue({
    apiKey,
    mode: "api-key",
    source: "test",
  });
}

function mockMissingLocalEmbeddingDependency() {
  vi.mocked(nodeLlamaModule.importNodeLlamaCpp).mockRejectedValue(
    Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
      code: "ERR_MODULE_NOT_FOUND",
    }),
  );
}

function createLocalProvider(options?: { fallback?: "none" | "openai" }) {
  return createEmbeddingProvider({
    config: {} as never,
    fallback: options?.fallback ?? "none",
    model: "text-embedding-3-small",
    provider: "local",
  });
}

function expectAutoSelectedProvider(
  result: Awaited<ReturnType<typeof createEmbeddingProvider>>,
  expectedId: "openai" | "gemini" | "mistral",
) {
  expect(result.requestedProvider).toBe("auto");
  const provider = requireProvider(result);
  expect(provider.id).toBe(expectedId);
  return provider;
}

function createAutoProvider(model = "") {
  return createEmbeddingProvider({
    config: {} as never,
    fallback: "none",
    model,
    provider: "auto",
  });
}

describe("embedding provider remote overrides", () => {
  it("uses remote baseUrl/apiKey and merges headers", async () => {
    const fetchMock = createFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    mockResolvedProviderKey("provider-key");

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            headers: {
              "X-Provider": "p",
              "X-Shared": "provider",
            },
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      fallback: "openai",
      model: "text-embedding-3-small",
      provider: "openai",
      remote: {
        apiKey: "  remote-key  ",
        baseUrl: "https://example.com/v1",
        headers: {
          "X-Remote": "r",
          "X-Shared": "remote",
        },
      },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    expect(authModule.resolveApiKeyForProvider).not.toHaveBeenCalled();
    const url = fetchMock.mock.calls[0]?.[0];
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(url).toBe("https://example.com/v1/embeddings");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer remote-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Provider"]).toBe("p");
    expect(headers["X-Shared"]).toBe("remote");
    expect(headers["X-Remote"]).toBe("r");
  });

  it("falls back to resolved api key when remote apiKey is blank", async () => {
    const fetchMock = createFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    mockResolvedProviderKey("provider-key");

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      fallback: "openai",
      model: "text-embedding-3-small",
      provider: "openai",
      remote: {
        apiKey: "   ",
        baseUrl: "https://example.com/v1",
      },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    expect(authModule.resolveApiKeyForProvider).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = (init?.headers as Record<string, string>) ?? {};
    expect(headers.Authorization).toBe("Bearer provider-key");
  });

  it("builds Gemini embeddings requests with api key header", async () => {
    const fetchMock = createGeminiFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    mockResolvedProviderKey("provider-key");

    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      fallback: "openai",
      model: "text-embedding-004",
      provider: "gemini",
      remote: {
        apiKey: "gemini-key",
      },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const { url, init } = readFirstFetchRequest(fetchMock);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
    );
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("gemini-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("fails fast when Gemini remote apiKey is an unresolved SecretRef", async () => {
    await expect(
      createEmbeddingProvider({
        config: {} as never,
        fallback: "openai",
        model: "text-embedding-004",
        provider: "gemini",
        remote: {
          apiKey: { id: "GEMINI_API_KEY", provider: "default", source: "env" },
        },
      }),
    ).rejects.toThrow(/agents\.\*\.memorySearch\.remote\.apiKey:/i);
  });

  it("uses GEMINI_API_KEY env indirection for Gemini remote apiKey", async () => {
    const fetchMock = createGeminiFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key");

    const result = await createEmbeddingProvider({
      config: {} as never,
      fallback: "openai",
      model: "text-embedding-004",
      provider: "gemini",
      remote: {
        apiKey: "GEMINI_API_KEY", // Pragma: allowlist secret
      },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const { init } = readFirstFetchRequest(fetchMock);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("env-gemini-key");
  });

  it("builds Mistral embeddings requests with bearer auth", async () => {
    const fetchMock = createFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    mockResolvedProviderKey("provider-key");

    const cfg = {
      models: {
        providers: {
          mistral: {
            baseUrl: "https://api.mistral.ai/v1",
          },
        },
      },
    };

    const result = await createEmbeddingProvider({
      config: cfg as never,
      fallback: "none",
      model: "mistral/mistral-embed",
      provider: "mistral",
      remote: {
        apiKey: "mistral-key", // Pragma: allowlist secret
      },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const { url, init } = readFirstFetchRequest(fetchMock);
    expect(url).toBe("https://api.mistral.ai/v1/embeddings");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mistral-key");
    const payload = JSON.parse((init?.body as string | undefined) ?? "{}") as { model?: string };
    expect(payload.model).toBe("mistral-embed");
  });
});

describe("embedding provider auto selection", () => {
  it("keeps explicit model when openai is selected", async () => {
    const fetchMock = vi.fn(async (_input?: unknown, _init?: unknown) => ({
      json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
      ok: true,
      status: 200,
    }));
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
    mockPublicPinnedHostname();
    vi.mocked(authModule.resolveApiKeyForProvider).mockImplementation(async ({ provider }) => {
      if (provider === "openai") {
        return { apiKey: "openai-key", mode: "api-key", source: "env: OPENAI_API_KEY" };
      }
      throw new Error(`Unexpected provider ${provider}`);
    });

    const result = await createEmbeddingProvider({
      config: {} as never,
      fallback: "none",
      model: "text-embedding-3-small",
      provider: "auto",
    });

    expect(result.requestedProvider).toBe("auto");
    const provider = requireProvider(result);
    expect(provider.id).toBe("openai");
    await provider.embedQuery("hello");
    const url = fetchMock.mock.calls[0]?.[0];
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    const payload = JSON.parse(init?.body as string) as { model?: string };
    expect(payload.model).toBe("text-embedding-3-small");
  });

  it("selects the first available remote provider in auto mode", async () => {
    const cases: {
      name: string;
      expectedProvider: "openai" | "gemini" | "mistral";
      fetchMockFactory: typeof createFetchMock | typeof createGeminiFetchMock;
      resolveApiKey: (provider: string) => ResolvedProviderAuth;
      expectedUrl: string;
    }[] = [
      {
        expectedProvider: "openai" as const,
        expectedUrl: "https://api.openai.com/v1/embeddings",
        fetchMockFactory: createFetchMock,
        name: "openai first",
        resolveApiKey(provider: string): ResolvedProviderAuth {
          if (provider === "openai") {
            return { apiKey: "openai-key", mode: "api-key", source: "env: OPENAI_API_KEY" };
          }
          throw new Error(`No API key found for provider "${provider}".`);
        },
      },
      {
        expectedProvider: "gemini" as const,
        expectedUrl: `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_EMBEDDING_MODEL}:embedContent`,
        fetchMockFactory: createGeminiFetchMock,
        name: "gemini fallback",
        resolveApiKey(provider: string): ResolvedProviderAuth {
          if (provider === "openai") {
            throw new Error('No API key found for provider "openai".');
          }
          if (provider === "google") {
            return {
              apiKey: "gemini-key",
              mode: "api-key" as const,
              source: "env: GEMINI_API_KEY",
            };
          }
          throw new Error(`Unexpected provider ${provider}`);
        },
      },
      {
        expectedProvider: "mistral" as const,
        expectedUrl: "https://api.mistral.ai/v1/embeddings",
        fetchMockFactory: createFetchMock,
        name: "mistral after earlier misses",
        resolveApiKey(provider: string): ResolvedProviderAuth {
          if (provider === "mistral") {
            return {
              apiKey: "mistral-key",
              mode: "api-key" as const,
              source: "env: MISTRAL_API_KEY",
            };
          }
          throw new Error(`No API key found for provider "${provider}".`);
        },
      },
    ];

    for (const testCase of cases) {
      vi.resetAllMocks();
      vi.unstubAllGlobals();
      const fetchMock = testCase.fetchMockFactory();
      installFetchMock(fetchMock as unknown as typeof globalThis.fetch);
      mockPublicPinnedHostname();
      vi.mocked(authModule.resolveApiKeyForProvider).mockImplementation(async ({ provider }) =>
        testCase.resolveApiKey(provider),
      );

      const result = await createAutoProvider();
      const provider = expectAutoSelectedProvider(result, testCase.expectedProvider);
      await provider.embedQuery("hello");
      const [url] = fetchMock.mock.calls[0] ?? [];
      expect(url, testCase.name).toBe(testCase.expectedUrl);
    }
  });
});

describe("embedding provider local fallback", () => {
  it("falls back to openai when node-llama-cpp is missing", async () => {
    mockMissingLocalEmbeddingDependency();

    const fetchMock = createFetchMock();
    installFetchMock(fetchMock as unknown as typeof globalThis.fetch);

    mockResolvedProviderKey("provider-key");

    const result = await createLocalProvider({ fallback: "openai" });

    const provider = requireProvider(result);
    expect(provider.id).toBe("openai");
    expect(result.fallbackFrom).toBe("local");
    expect(result.fallbackReason).toContain("node-llama-cpp");
  });

  it("throws a helpful error when local is requested and fallback is none", async () => {
    mockMissingLocalEmbeddingDependency();
    await expect(createLocalProvider()).rejects.toThrow(/optional dependency node-llama-cpp/i);
  });

  it("mentions every remote provider in local setup guidance", async () => {
    mockMissingLocalEmbeddingDependency();
    await expect(createLocalProvider()).rejects.toThrow(/provider = "gemini"/i);
    await expect(createLocalProvider()).rejects.toThrow(/provider = "mistral"/i);
  });
});

describe("local embedding normalization", () => {
  async function createLocalProviderForTest() {
    return createEmbeddingProvider({
      config: {} as never,
      fallback: "none",
      model: "",
      provider: "local",
    });
  }

  function mockSingleLocalEmbeddingVector(
    vector: number[],
    resolveModelFile: (modelPath: string, modelDirectory?: string) => Promise<string> = async () =>
      "/fake/model.gguf",
  ): void {
    vi.mocked(nodeLlamaModule.importNodeLlamaCpp).mockResolvedValue({
      LlamaLogLevel: { error: 0 },
      getLlama: async () => ({
        loadModel: vi.fn().mockResolvedValue({
          createEmbeddingContext: vi.fn().mockResolvedValue({
            getEmbeddingFor: vi.fn().mockResolvedValue({
              vector: new Float32Array(vector),
            }),
          }),
        }),
      }),
      resolveModelFile,
    } as never);
  }

  it("normalizes local embeddings to magnitude ~1.0", async () => {
    const unnormalizedVector = [2.35, 3.45, 0.63, 4.3, 1.2, 5.1, 2.8, 3.9];
    const resolveModelFileMock = vi.fn(async () => "/fake/model.gguf");

    mockSingleLocalEmbeddingVector(unnormalizedVector, resolveModelFileMock);

    const result = await createLocalProviderForTest();

    const provider = requireProvider(result);
    const embedding = await provider.embedQuery("test query");

    const magnitude = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));

    expect(magnitude).toBeCloseTo(1, 5);
    expect(resolveModelFileMock).toHaveBeenCalledWith(DEFAULT_LOCAL_MODEL, undefined);
  });

  it("handles zero vector without division by zero", async () => {
    const zeroVector = [0, 0, 0, 0];

    mockSingleLocalEmbeddingVector(zeroVector);

    const result = await createLocalProviderForTest();

    const provider = requireProvider(result);
    const embedding = await provider.embedQuery("test");

    expect(embedding).toEqual([0, 0, 0, 0]);
    expect(embedding.every((value) => Number.isFinite(value))).toBe(true);
  });

  it("sanitizes non-finite values before normalization", async () => {
    const nonFiniteVector = [1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    mockSingleLocalEmbeddingVector(nonFiniteVector);

    const result = await createLocalProviderForTest();

    const provider = requireProvider(result);
    const embedding = await provider.embedQuery("test");

    expect(embedding).toEqual([1, 0, 0, 0]);
    expect(embedding.every((value) => Number.isFinite(value))).toBe(true);
  });

  it("normalizes batch embeddings to magnitude ~1.0", async () => {
    const unnormalizedVectors = [
      [2.35, 3.45, 0.63, 4.3],
      [10, 0, 0, 0],
      [1, 1, 1, 1],
    ];

    vi.mocked(nodeLlamaModule.importNodeLlamaCpp).mockResolvedValue({
      LlamaLogLevel: { error: 0 },
      getLlama: async () => ({
        loadModel: vi.fn().mockResolvedValue({
          createEmbeddingContext: vi.fn().mockResolvedValue({
            getEmbeddingFor: vi
              .fn()
              .mockResolvedValueOnce({ vector: new Float32Array(unnormalizedVectors[0]) })
              .mockResolvedValueOnce({ vector: new Float32Array(unnormalizedVectors[1]) })
              .mockResolvedValueOnce({ vector: new Float32Array(unnormalizedVectors[2]) }),
          }),
        }),
      }),
      resolveModelFile: async () => "/fake/model.gguf",
    } as never);

    const result = await createLocalProviderForTest();

    const provider = requireProvider(result);
    const embeddings = await provider.embedBatch(["text1", "text2", "text3"]);

    for (const embedding of embeddings) {
      const magnitude = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));
      expect(magnitude).toBeCloseTo(1, 5);
    }
  });
});

describe("local embedding ensureContext concurrency", () => {
  async function setupLocalProviderWithMockedInit(params?: {
    initializationDelayMs?: number;
    failFirstGetLlama?: boolean;
  }) {
    const getLlamaSpy = vi.fn();
    const loadModelSpy = vi.fn();
    const createContextSpy = vi.fn();
    let shouldFail = params?.failFirstGetLlama ?? false;

    vi.spyOn(nodeLlamaModule, "importNodeLlamaCpp").mockResolvedValue({
      LlamaLogLevel: { error: 0 },
      getLlama: async (...args: unknown[]) => {
        getLlamaSpy(...args);
        if (shouldFail) {
          shouldFail = false;
          throw new Error("transient init failure");
        }
        if (params?.initializationDelayMs) {
          await sleep(params.initializationDelayMs);
        }
        return {
          loadModel: async (...modelArgs: unknown[]) => {
            loadModelSpy(...modelArgs);
            if (params?.initializationDelayMs) {
              await sleep(params.initializationDelayMs);
            }
            return {
              createEmbeddingContext: async () => {
                createContextSpy();
                return {
                  getEmbeddingFor: vi.fn().mockResolvedValue({
                    vector: new Float32Array([1, 0, 0, 0]),
                  }),
                };
              },
            };
          },
        };
      },
      resolveModelFile: async () => "/fake/model.gguf",
    } as never);

    const result = await createEmbeddingProvider({
      config: {} as never,
      fallback: "none",
      model: "",
      provider: "local",
    });

    return {
      createContextSpy,
      getLlamaSpy,
      loadModelSpy,
      provider: requireProvider(result),
    };
  }

  it("loads the model only once when embedBatch is called concurrently", async () => {
    const { provider, getLlamaSpy, loadModelSpy, createContextSpy } =
      await setupLocalProviderWithMockedInit({
        initializationDelayMs: 50,
      });

    const results = await Promise.all([
      provider.embedBatch(["text1"]),
      provider.embedBatch(["text2"]),
      provider.embedBatch(["text3"]),
      provider.embedBatch(["text4"]),
    ]);

    expect(results).toHaveLength(4);
    for (const embeddings of results) {
      expect(embeddings).toHaveLength(1);
      expect(embeddings[0]).toHaveLength(4);
    }

    expect(getLlamaSpy).toHaveBeenCalledTimes(1);
    expect(loadModelSpy).toHaveBeenCalledTimes(1);
    expect(createContextSpy).toHaveBeenCalledTimes(1);
  });

  it("retries initialization after a transient ensureContext failure", async () => {
    const { provider, getLlamaSpy, loadModelSpy, createContextSpy } =
      await setupLocalProviderWithMockedInit({
        failFirstGetLlama: true,
      });

    await expect(provider.embedBatch(["first"])).rejects.toThrow("transient init failure");

    const recovered = await provider.embedBatch(["second"]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toHaveLength(4);

    expect(getLlamaSpy).toHaveBeenCalledTimes(2);
    expect(loadModelSpy).toHaveBeenCalledTimes(1);
    expect(createContextSpy).toHaveBeenCalledTimes(1);
  });

  it("shares initialization when embedQuery and embedBatch start concurrently", async () => {
    const { provider, getLlamaSpy, loadModelSpy, createContextSpy } =
      await setupLocalProviderWithMockedInit({
        initializationDelayMs: 50,
      });

    const [queryA, batch, queryB] = await Promise.all([
      provider.embedQuery("query-a"),
      provider.embedBatch(["batch-a", "batch-b"]),
      provider.embedQuery("query-b"),
    ]);

    expect(queryA).toHaveLength(4);
    expect(batch).toHaveLength(2);
    expect(queryB).toHaveLength(4);
    expect(batch[0]).toHaveLength(4);
    expect(batch[1]).toHaveLength(4);

    expect(getLlamaSpy).toHaveBeenCalledTimes(1);
    expect(loadModelSpy).toHaveBeenCalledTimes(1);
    expect(createContextSpy).toHaveBeenCalledTimes(1);
  });
});

describe("FTS-only fallback when no provider available", () => {
  it("returns null provider when all requested auth paths fail", async () => {
    vi.mocked(authModule.resolveApiKeyForProvider).mockRejectedValue(
      new Error("No API key found for provider"),
    );

    for (const testCase of [
      {
        fallbackFrom: undefined,
        name: "auto mode",
        options: {
          config: {} as never,
          fallback: "none" as const,
          model: "",
          provider: "auto" as const,
        },
        reasonIncludes: "No API key",
        requestedProvider: "auto",
      },
      {
        fallbackFrom: undefined,
        name: "explicit provider only",
        options: {
          config: {} as never,
          fallback: "none" as const,
          model: "text-embedding-3-small",
          provider: "openai" as const,
        },
        reasonIncludes: "No API key",
        requestedProvider: "openai",
      },
      {
        fallbackFrom: "openai",
        name: "primary and fallback",
        options: {
          config: {} as never,
          fallback: "gemini" as const,
          model: "text-embedding-3-small",
          provider: "openai" as const,
        },
        reasonIncludes: "Fallback to gemini failed",
        requestedProvider: "openai",
      },
    ]) {
      const result = await createEmbeddingProvider(testCase.options);
      expect(result.provider, testCase.name).toBeNull();
      expect(result.requestedProvider, testCase.name).toBe(testCase.requestedProvider);
      expect(result.fallbackFrom, testCase.name).toBe(testCase.fallbackFrom);
      expect(result.providerUnavailableReason, testCase.name).toContain(testCase.reasonIncludes);
    }
  });
});
