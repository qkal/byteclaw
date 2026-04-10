import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "../plugins/memory-embedding-providers.js";
import { resolveMemorySearchConfig, resolveMemorySearchSyncConfig } from "./memory-search.js";

const asConfig = (cfg: OpenClawConfig): OpenClawConfig => cfg;

function registerBaseMemoryEmbeddingProviders(options?: { includeGemini?: boolean }): void {
  registerMemoryEmbeddingProvider({
    create: async () => ({ provider: null }),
    defaultModel: "text-embedding-3-small",
    id: "openai",
    transport: "remote",
  });
  registerMemoryEmbeddingProvider({
    create: async () => ({ provider: null }),
    defaultModel: "local-default",
    id: "local",
    transport: "local",
  });
  if (options?.includeGemini !== false) {
    registerMemoryEmbeddingProvider({
      create: async () => ({ provider: null }),
      defaultModel: "gemini-embedding-001",
      id: "gemini",
      supportsMultimodalEmbeddings: ({ model }) =>
        model
          .trim()
          .replace(/^models\//, "")
          .replace(/^(gemini|google)\//, "") === "gemini-embedding-2-preview",
      transport: "remote",
    });
  }
  registerMemoryEmbeddingProvider({
    create: async () => ({ provider: null }),
    defaultModel: "voyage-4-large",
    id: "voyage",
    transport: "remote",
  });
  registerMemoryEmbeddingProvider({
    create: async () => ({ provider: null }),
    defaultModel: "mistral-embed",
    id: "mistral",
    transport: "remote",
  });
  registerMemoryEmbeddingProvider({
    create: async () => ({ provider: null }),
    defaultModel: "nomic-embed-text",
    id: "ollama",
    transport: "remote",
  });
}

describe("memory search config", () => {
  beforeEach(() => {
    clearMemoryEmbeddingProviders();
    registerBaseMemoryEmbeddingProviders();
  });

  afterEach(() => {
    clearMemoryEmbeddingProviders();
  });

  function configWithDefaultProvider(provider: string): OpenClawConfig {
    return asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider,
          },
        },
      },
    });
  }

  function expectDefaultRemoteBatch(resolved: ReturnType<typeof resolveMemorySearchConfig>): void {
    expect(resolved?.remote?.batch).toEqual({
      concurrency: 2,
      enabled: false,
      pollIntervalMs: 2000,
      timeoutMinutes: 60,
      wait: true,
    });
  }

  function expectEmptyMultimodalConfig(resolved: ReturnType<typeof resolveMemorySearchConfig>) {
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      maxFileBytes: 10 * 1024 * 1024,
      modalities: [],
    });
  }

  function configWithRemoteDefaults(remote: Record<string, unknown>) {
    return asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            remote,
          },
        },
        list: [
          {
            default: true,
            id: "main",
            memorySearch: {
              remote: {
                baseUrl: "https://agent.example/v1",
              },
            },
          },
        ],
      },
    });
  }

  function expectMergedRemoteConfig(
    resolved: ReturnType<typeof resolveMemorySearchConfig>,
    apiKey: unknown,
  ) {
    expect(resolved?.remote).toEqual({
      apiKey,
      baseUrl: "https://agent.example/v1",
      batch: {
        concurrency: 2,
        enabled: false,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
        wait: true,
      },
      headers: { "X-Default": "on" },
    });
  }

  it("returns null when disabled", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: { enabled: true },
        },
        list: [
          {
            default: true,
            id: "main",
            memorySearch: { enabled: false },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("returns null sync config when disabled", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: { enabled: true },
        },
        list: [
          {
            default: true,
            id: "main",
            memorySearch: { enabled: false },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchSyncConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("defaults provider to auto when unspecified", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("auto");
    expect(resolved?.fallback).toBe("none");
  });

  it("resolves sync config without consulting embedding providers", () => {
    clearMemoryEmbeddingProviders();
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sync: {
              intervalMinutes: 3,
              onSearch: true,
              onSessionStart: false,
              sessions: {
                deltaBytes: 321,
                deltaMessages: 7,
                postCompactionForce: false,
              },
              watch: false,
              watchDebounceMs: 25,
            },
          },
        },
      },
    });

    expect(resolveMemorySearchSyncConfig(cfg, "main")).toEqual({
      intervalMinutes: 3,
      onSearch: true,
      onSessionStart: false,
      sessions: {
        deltaBytes: 321,
        deltaMessages: 7,
        postCompactionForce: false,
      },
      watch: false,
      watchDebounceMs: 25,
    });
  });

  it("merges defaults and overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            chunking: { overlap: 100, tokens: 500 },
            model: "text-embedding-3-small",
            provider: "openai",
            query: { maxResults: 4, minScore: 0.2 },
            store: {
              vector: {
                enabled: false,
                extensionPath: "/opt/sqlite-vec.dylib",
              },
            },
          },
        },
        list: [
          {
            default: true,
            id: "main",
            memorySearch: {
              chunking: { tokens: 320 },
              query: { maxResults: 8 },
              store: {
                vector: {
                  enabled: true,
                },
              },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("openai");
    expect(resolved?.model).toBe("text-embedding-3-small");
    expect(resolved?.chunking.tokens).toBe(320);
    expect(resolved?.chunking.overlap).toBe(100);
    expect(resolved?.query.maxResults).toBe(8);
    expect(resolved?.query.minScore).toBe(0.2);
    expect(resolved?.store.vector.enabled).toBe(true);
    expect(resolved?.store.vector.extensionPath).toBe("/opt/sqlite-vec.dylib");
  });

  it("merges extra memory paths from defaults and overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            extraPaths: ["/shared/notes", " docs "],
          },
        },
        list: [
          {
            default: true,
            id: "main",
            memorySearch: {
              extraPaths: ["/shared/notes", "../team-notes"],
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.extraPaths).toEqual(["/shared/notes", "docs", "../team-notes"]);
  });

  it("normalizes multimodal settings", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            model: "gemini-embedding-2-preview",
            multimodal: {
              enabled: true,
              maxFileBytes: 8192,
              modalities: ["all"],
            },
            provider: "gemini",
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      maxFileBytes: 8192,
      modalities: ["image", "audio"],
    });
  });

  it("keeps an explicit empty multimodal modalities list empty", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            model: "gemini-embedding-2-preview",
            multimodal: {
              enabled: true,
              modalities: [],
            },
            provider: "gemini",
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectEmptyMultimodalConfig(resolved);
    expect(resolved?.provider).toBe("gemini");
  });

  it("does not enforce multimodal provider validation when no modalities are active", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "openai",
            model: "text-embedding-3-small",
            multimodal: {
              enabled: true,
              modalities: [],
            },
            provider: "openai",
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectEmptyMultimodalConfig(resolved);
  });

  it("rejects multimodal memory on unsupported providers", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            model: "text-embedding-3-small",
            multimodal: { enabled: true, modalities: ["image"] },
            provider: "openai",
          },
        },
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memorySearch\.multimodal requires a provider adapter that supports multimodal embeddings/,
    );
  });

  it("accepts Gemini multimodal memory even when the runtime registry has not registered Gemini yet", () => {
    clearMemoryEmbeddingProviders();
    registerBaseMemoryEmbeddingProviders({ includeGemini: false });
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            model: "gemini-embedding-2-preview",
            multimodal: { enabled: true, modalities: ["image"] },
            provider: "gemini",
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("gemini");
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      maxFileBytes: 10 * 1024 * 1024,
      modalities: ["image"],
    });
  });

  it("rejects multimodal memory when fallback is configured", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "openai",
            model: "gemini-embedding-2-preview",
            multimodal: { enabled: true, modalities: ["image"] },
            provider: "gemini",
          },
        },
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memorySearch\.multimodal does not support memorySearch\.fallback/,
    );
  });

  it("includes batch defaults for openai without remote overrides", () => {
    const cfg = configWithDefaultProvider("openai");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
  });

  it("keeps remote unset for local provider without overrides", () => {
    const cfg = configWithDefaultProvider("local");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toBeUndefined();
  });

  it("includes remote defaults for gemini without overrides", () => {
    const cfg = configWithDefaultProvider("gemini");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
  });

  it("includes remote defaults and model default for mistral without overrides", () => {
    const cfg = configWithDefaultProvider("mistral");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
    expect(resolved?.model).toBe("mistral-embed");
  });

  it("includes remote defaults and model default for ollama without overrides", () => {
    const cfg = configWithDefaultProvider("ollama");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
    expect(resolved?.model).toBe("nomic-embed-text");
  });

  it("defaults session delta thresholds", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sync.sessions).toEqual({
      deltaBytes: 100_000,
      deltaMessages: 50,
      postCompactionForce: true,
    });
  });

  it("merges remote defaults with agent overrides", () => {
    const cfg = configWithRemoteDefaults({
      baseUrl: "https://default.example/v1",
      apiKey: "default-key", // Pragma: allowlist secret
      headers: { "X-Default": "on" },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectMergedRemoteConfig(resolved, "default-key"); // Pragma: allowlist secret
  });

  it("preserves SecretRef remote apiKey when merging defaults with agent overrides", () => {
    const cfg = configWithRemoteDefaults({
      apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" }, // Pragma: allowlist secret
      headers: { "X-Default": "on" },
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");

    expectMergedRemoteConfig(resolved, {
      id: "OPENAI_API_KEY",
      provider: "default",
      source: "env",
    });
  });

  it("gates session sources behind experimental flag", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sources: ["memory", "sessions"],
          },
        },
        list: [
          {
            default: true,
            id: "main",
            memorySearch: {
              experimental: { sessionMemory: false },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("allows session sources when experimental flag is enabled", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            experimental: { sessionMemory: true },
            provider: "openai",
            sources: ["memory", "sessions"],
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toContain("sessions");
  });
});
