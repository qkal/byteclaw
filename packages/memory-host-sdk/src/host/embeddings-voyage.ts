import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export interface VoyageEmbeddingClient {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
}

export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const VOYAGE_MAX_INPUT_TOKENS: Record<string, number> = {
  "voyage-3": 32_000,
  "voyage-3-lite": 16_000,
  "voyage-code-3": 32_000,
};

export function normalizeVoyageModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
    model,
    prefixes: ["voyage/"],
  });
}

export async function createVoyageEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: VoyageEmbeddingClient }> {
  const client = await resolveVoyageEmbeddingClient(options);
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[], input_type?: "query" | "document"): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    const body: { model: string; input: string[]; input_type?: "query" | "document" } = {
      input,
      model: client.model,
    };
    if (input_type) {
      body.input_type = input_type;
    }

    return await fetchRemoteEmbeddingVectors({
      body,
      errorPrefix: "voyage embeddings failed",
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      url,
    });
  };

  return {
    client,
    provider: {
      embedBatch: async (texts) => embed(texts, "document"),
      embedQuery: async (text) => {
        const [vec] = await embed([text], "query");
        return vec ?? [];
      },
      id: "voyage",
      maxInputTokens: VOYAGE_MAX_INPUT_TOKENS[client.model],
      model: client.model,
    },
  };
}

export async function resolveVoyageEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<VoyageEmbeddingClient> {
  const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
    defaultBaseUrl: DEFAULT_VOYAGE_BASE_URL,
    options,
    provider: "voyage",
  });
  const model = normalizeVoyageModel(options.model);
  return { baseUrl, headers, model, ssrfPolicy };
}
