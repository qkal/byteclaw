import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { describe, expect, it, vi } from "vitest";
import {
  applyMemoryFallbackProviderState,
  resolveMemoryFallbackProviderRequest,
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderState,
} from "./manager-provider-state.js";

const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";

vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderFallbackModel: (providerId: string, fallbackSourceModel: string) =>
    providerId === "ollama" ? DEFAULT_OLLAMA_EMBEDDING_MODEL : fallbackSourceModel,
}));

interface EmbeddingProvider {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
}

interface EmbeddingProviderRuntime {
  id: string;
  cacheKeyData: { provider: string; model: string };
}

function createProvider(id: string): EmbeddingProvider {
  return {
    embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
    embedQuery: async () => [0.1, 0.2, 0.3],
    id,
    model: `${id}-model`,
  };
}

function createSettings(params: {
  provider: "openai" | "mistral";
  fallback?: "none" | "mistral" | "ollama";
}): ResolvedMemorySearchConfig {
  return {
    fallback: params.fallback ?? "none",
    local: undefined,
    model: params.provider === "mistral" ? "mistral/mistral-embed" : "text-embedding-3-small",
    outputDimensionality: undefined,
    provider: params.provider,
    remote: undefined,
  } as unknown as ResolvedMemorySearchConfig;
}

describe("memory manager mistral provider wiring", () => {
  it("stores mistral client when mistral provider is selected", () => {
    const mistralRuntime: EmbeddingProviderRuntime = {
      cacheKeyData: { model: "mistral-embed", provider: "mistral" },
      id: "mistral",
    };

    const state = resolveMemoryProviderState({
      fallbackFrom: undefined,
      fallbackReason: undefined,
      provider: createProvider("mistral"),
      providerUnavailableReason: undefined,
      runtime: mistralRuntime,
    });

    expect(state.provider?.id).toBe("mistral");
    expect(state.providerRuntime).toBe(mistralRuntime);
  });

  it("stores mistral client after fallback activation", () => {
    const openAiRuntime: EmbeddingProviderRuntime = {
      cacheKeyData: { model: "text-embedding-3-small", provider: "openai" },
      id: "openai",
    };
    const mistralRuntime: EmbeddingProviderRuntime = {
      cacheKeyData: { model: "mistral-embed", provider: "mistral" },
      id: "mistral",
    };
    const current = resolveMemoryProviderState({
      fallbackFrom: undefined,
      fallbackReason: undefined,
      provider: createProvider("openai"),
      providerUnavailableReason: undefined,
      runtime: openAiRuntime,
    });

    const fallbackState = applyMemoryFallbackProviderState({
      current,
      fallbackFrom: "openai",
      reason: "forced test",
      result: {
        provider: createProvider("mistral"),
        runtime: mistralRuntime,
      },
    });

    expect(fallbackState.fallbackFrom).toBe("openai");
    expect(fallbackState.fallbackReason).toBe("forced test");
    expect(fallbackState.provider?.id).toBe("mistral");
    expect(fallbackState.providerRuntime).toBe(mistralRuntime);
  });

  it("uses default ollama model when activating ollama fallback", () => {
    const request = resolveMemoryFallbackProviderRequest({
      cfg: {} as OpenClawConfig,
      currentProviderId: "openai",
      settings: createSettings({ fallback: "ollama", provider: "openai" }),
    });

    expect(request?.provider).toBe("ollama");
    expect(request?.model).toBe(DEFAULT_OLLAMA_EMBEDDING_MODEL);
    expect(request?.fallback).toBe("none");
  });

  it("includes outputDimensionality in the primary provider request", () => {
    const request = resolveMemoryPrimaryProviderRequest({
      settings: {
        ...createSettings({ provider: "mistral" }),
        model: "gemini-embedding-2-preview",
        outputDimensionality: 1536,
        provider: "gemini",
      } as ResolvedMemorySearchConfig,
    });

    expect(request.provider).toBe("gemini");
    expect(request.model).toBe("gemini-embedding-2-preview");
    expect(request.outputDimensionality).toBe(1536);
  });
});
