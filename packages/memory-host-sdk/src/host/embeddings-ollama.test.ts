import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";

let createOllamaEmbeddingProvider: typeof import("./embeddings-ollama.js").createOllamaEmbeddingProvider;

beforeAll(async () => {
  ({ createOllamaEmbeddingProvider } = await import("./embeddings-ollama.js"));
});

beforeEach(() => {
  vi.useRealTimers();
  vi.doUnmock("undici");
});

afterEach(() => {
  vi.doUnmock("undici");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("embeddings-ollama", () => {
  it("calls /api/embeddings and returns normalized vectors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding: [3, 4] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      fallback: "none",
      model: "nomic-embed-text",
      provider: "ollama",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    const v = await provider.embedQuery("hi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Normalized [3,4] => [0.6,0.8]
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
  });

  it("resolves baseUrl/apiKey/headers from models.providers.ollama and strips /v1", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding: [1, 0] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "ollama-\nlocal\r\n", // Pragma: allowlist secret
              headers: {
                "X-Provider-Header": "provider",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      fallback: "none",
      model: "",
      provider: "ollama",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-local",
          "Content-Type": "application/json",
          "X-Provider-Header": "provider",
        }),
        method: "POST",
      }),
    );
  });

  it("fails fast when memory-search remote apiKey is an unresolved SecretRef", async () => {
    await expect(
      createOllamaEmbeddingProvider({
        config: {} as OpenClawConfig,
        fallback: "none",
        model: "nomic-embed-text",
        provider: "ollama",
        remote: {
          apiKey: { id: "OLLAMA_API_KEY", provider: "default", source: "env" },
          baseUrl: "http://127.0.0.1:11434",
        },
      }),
    ).rejects.toThrow(/agents\.\*\.memorySearch\.remote\.apiKey: unresolved SecretRef/i);
  });

  it("falls back to env key when models.providers.ollama.apiKey is an unresolved SecretRef", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding: [1, 0] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              apiKey: { id: "OLLAMA_API_KEY", provider: "default", source: "env" },
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      fallback: "none",
      model: "nomic-embed-text",
      provider: "ollama",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-env",
        }),
      }),
    );
  });
});
