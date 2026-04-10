import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
} from "./embeddings-remote-provider.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";

export interface MistralEmbeddingClient {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
}

export const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

export function normalizeMistralModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
    model,
    prefixes: ["mistral/"],
  });
}

export async function createMistralEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: MistralEmbeddingClient }> {
  const client = await resolveMistralEmbeddingClient(options);

  return {
    client,
    provider: createRemoteEmbeddingProvider({
      client,
      errorPrefix: "mistral embeddings failed",
      id: "mistral",
    }),
  };
}

export async function resolveMistralEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<MistralEmbeddingClient> {
  return await resolveRemoteEmbeddingClient({
    defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
    normalizeModel: normalizeMistralModel,
    options,
    provider: "mistral",
  });
}
