import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import {
  type RemoteEmbeddingProviderId,
  resolveRemoteEmbeddingBearerClient,
} from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";

export interface RemoteEmbeddingClient {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  model: string;
}

export function createRemoteEmbeddingProvider(params: {
  id: string;
  client: RemoteEmbeddingClient;
  errorPrefix: string;
  maxInputTokens?: number;
}): EmbeddingProvider {
  const { client } = params;
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    return await fetchRemoteEmbeddingVectors({
      body: { input, model: client.model },
      errorPrefix: params.errorPrefix,
      fetchImpl: client.fetchImpl,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      url,
    });
  };

  return {
    id: params.id,
    model: client.model,
    ...(typeof params.maxInputTokens === "number" ? { maxInputTokens: params.maxInputTokens } : {}),
    embedQuery: async (text) => {
      const [vec] = await embed([text]);
      return vec ?? [];
    },
    embedBatch: embed,
  };
}

export async function resolveRemoteEmbeddingClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
  normalizeModel: (model: string) => string;
}): Promise<RemoteEmbeddingClient> {
  const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
    defaultBaseUrl: params.defaultBaseUrl,
    options: params.options,
    provider: params.provider,
  });
  const model = params.normalizeModel(params.options.model);
  return { baseUrl, headers, model, ssrfPolicy };
}
