import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
} from "./embedding-provider.js";

export const ollamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  create: async (options) => {
    const { provider, client } = await createOllamaEmbeddingProvider({
      ...options,
      fallback: "none",
      provider: "ollama",
    });
    return {
      provider,
      runtime: {
        cacheKeyData: {
          model: client.model,
          provider: "ollama",
        },
        id: "ollama",
      },
    };
  },
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  id: "ollama",
  transport: "remote",
};
