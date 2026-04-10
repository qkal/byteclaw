import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import { OPENAI_DEFAULT_EMBEDDING_MODEL } from "../../../../src/plugins/provider-model-defaults.js";
import { normalizeEmbeddingModelWithPrefixes } from "./embeddings-model-normalize.js";
import {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
} from "./embeddings-remote-provider.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";

export interface OpenAiEmbeddingClient {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_EMBEDDING_MODEL = OPENAI_DEFAULT_EMBEDDING_MODEL;
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-3-large": 8192,
  "text-embedding-3-small": 8192,
  "text-embedding-ada-002": 8191,
};

export function normalizeOpenAiModel(model: string): string {
  return normalizeEmbeddingModelWithPrefixes({
    defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    model,
    prefixes: ["openai/"],
  });
}

export async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const client = await resolveOpenAiEmbeddingClient(options);

  return {
    client,
    provider: createRemoteEmbeddingProvider({
      client,
      errorPrefix: "openai embeddings failed",
      id: "openai",
      maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model],
    }),
  };
}

export async function resolveOpenAiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<OpenAiEmbeddingClient> {
  return await resolveRemoteEmbeddingClient({
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    normalizeModel: normalizeOpenAiModel,
    options,
    provider: "openai",
  });
}
