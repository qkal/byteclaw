import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../../../../src/agents/api-key-rotation.js";
import { requireApiKey, resolveApiKeyForProvider } from "../../../../src/agents/model-auth.js";
import { parseGeminiAuth } from "../../../../src/infra/gemini-auth.js";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleApiBaseUrl,
} from "../../../../src/infra/google-api-base-url.js";
import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import type { EmbeddingInput } from "./embedding-inputs.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export interface GeminiEmbeddingClient {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
  modelPath: string;
  apiKeys: string[];
  outputDimensionality?: number;
}

export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-004": 2048,
};

// --- gemini-embedding-2-preview support ---

export const GEMINI_EMBEDDING_2_MODELS = new Set([
  "gemini-embedding-2-preview",
  // Add the GA model name here once released.
]);

const GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS = 3072;
const GEMINI_EMBEDDING_2_VALID_DIMENSIONS = [768, 1536, 3072] as const;

export type GeminiTaskType =
  | "RETRIEVAL_QUERY"
  | "RETRIEVAL_DOCUMENT"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION";

export interface GeminiTextPart { text: string }
export interface GeminiInlinePart {
  inlineData: { mimeType: string; data: string };
}
export type GeminiPart = GeminiTextPart | GeminiInlinePart;
export interface GeminiEmbeddingRequest {
  content: { parts: GeminiPart[] };
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  model?: string;
}
export type GeminiTextEmbeddingRequest = GeminiEmbeddingRequest;

/** Builds the text-only Gemini embedding request shape used across direct and batch APIs. */
export function buildGeminiTextEmbeddingRequest(params: {
  text: string;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiTextEmbeddingRequest {
  return buildGeminiEmbeddingRequest({
    input: { text: params.text },
    modelPath: params.modelPath,
    outputDimensionality: params.outputDimensionality,
    taskType: params.taskType,
  });
}

export function buildGeminiEmbeddingRequest(params: {
  input: EmbeddingInput;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiEmbeddingRequest {
  const request: GeminiEmbeddingRequest = {
    content: {
      parts: params.input.parts?.map((part) =>
        part.type === "text"
          ? ({ text: part.text } satisfies GeminiTextPart)
          : ({
              inlineData: { data: part.data, mimeType: part.mimeType },
            } satisfies GeminiInlinePart),
      ) ?? [{ text: params.input.text }],
    },
    taskType: params.taskType,
  };
  if (params.modelPath) {
    request.model = params.modelPath;
  }
  if (params.outputDimensionality != null) {
    request.outputDimensionality = params.outputDimensionality;
  }
  return request;
}

/**
 * Returns true if the given model name is a gemini-embedding-2 variant that
 * supports `outputDimensionality` and extended task types.
 */
export function isGeminiEmbedding2Model(model: string): boolean {
  return GEMINI_EMBEDDING_2_MODELS.has(model);
}

/**
 * Validate and return the `outputDimensionality` for gemini-embedding-2 models.
 * Returns `undefined` for older models (they don't support the param).
 */
export function resolveGeminiOutputDimensionality(
  model: string,
  requested?: number,
): number | undefined {
  if (!isGeminiEmbedding2Model(model)) {
    return undefined;
  }
  if (requested == null) {
    return GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS;
  }
  const valid: readonly number[] = GEMINI_EMBEDDING_2_VALID_DIMENSIONS;
  if (!valid.includes(requested)) {
    throw new Error(
      `Invalid outputDimensionality ${requested} for ${model}. Valid values: ${valid.join(", ")}`,
    );
  }
  return requested;
}
function resolveRemoteApiKey(remoteApiKey: unknown): string | undefined {
  const trimmed = resolveMemorySecretInputString({
    path: "agents.*.memorySearch.remote.apiKey",
    value: remoteApiKey,
  });
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "GOOGLE_API_KEY" || trimmed === "GEMINI_API_KEY") {
    return process.env[trimmed]?.trim();
  }
  return trimmed;
}

export function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_GEMINI_EMBEDDING_MODEL;
  }
  const withoutPrefix = trimmed.replace(/^models\//, "");
  if (withoutPrefix.startsWith("gemini/")) {
    return withoutPrefix.slice("gemini/".length);
  }
  if (withoutPrefix.startsWith("google/")) {
    return withoutPrefix.slice("google/".length);
  }
  return withoutPrefix;
}

async function fetchGeminiEmbeddingPayload(params: {
  client: GeminiEmbeddingClient;
  endpoint: string;
  body: unknown;
}): Promise<{
  embedding?: { values?: number[] };
  embeddings?: { values?: number[] }[];
}> {
  return await executeWithApiKeyRotation({
    apiKeys: params.client.apiKeys,
    execute: async (apiKey) => {
      const authHeaders = parseGeminiAuth(apiKey);
      const headers = {
        ...authHeaders.headers,
        ...params.client.headers,
      };
      return await withRemoteHttpResponse({
        init: {
          body: JSON.stringify(params.body),
          headers,
          method: "POST",
        },
        onResponse: async (res) => {
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`gemini embeddings failed: ${res.status} ${text}`);
          }
          return (await res.json()) as {
            embedding?: { values?: number[] };
            embeddings?: Array<{ values?: number[] }>;
          };
        },
        ssrfPolicy: params.client.ssrfPolicy,
        url: params.endpoint,
      });
    },
    provider: "google",
  });
}

function normalizeGeminiBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  const openAiIndex = trimmed.indexOf("/openai");
  if (openAiIndex !== -1) {
    return normalizeGoogleApiBaseUrl(trimmed.slice(0, openAiIndex));
  }
  return normalizeGoogleApiBaseUrl(trimmed);
}

function buildGeminiModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export async function createGeminiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: GeminiEmbeddingClient }> {
  const client = await resolveGeminiEmbeddingClient(options);
  const baseUrl = client.baseUrl.replace(/\/$/, "");
  const embedUrl = `${baseUrl}/${client.modelPath}:embedContent`;
  const batchUrl = `${baseUrl}/${client.modelPath}:batchEmbedContents`;
  const isV2 = isGeminiEmbedding2Model(client.model);
  const {outputDimensionality} = client;

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const payload = await fetchGeminiEmbeddingPayload({
      body: buildGeminiTextEmbeddingRequest({
        outputDimensionality: isV2 ? outputDimensionality : undefined,
        taskType: options.taskType ?? "RETRIEVAL_QUERY",
        text,
      }),
      client,
      endpoint: embedUrl,
    });
    return sanitizeAndNormalizeEmbedding(payload.embedding?.values ?? []);
  };

  const embedBatchInputs = async (inputs: EmbeddingInput[]): Promise<number[][]> => {
    if (inputs.length === 0) {
      return [];
    }
    const payload = await fetchGeminiEmbeddingPayload({
      body: {
        requests: inputs.map((input) =>
          buildGeminiEmbeddingRequest({
            input,
            modelPath: client.modelPath,
            outputDimensionality: isV2 ? outputDimensionality : undefined,
            taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
          }),
        ),
      },
      client,
      endpoint: batchUrl,
    });
    const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return inputs.map((_, index) => sanitizeAndNormalizeEmbedding(embeddings[index]?.values ?? []));
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => await embedBatchInputs(
      texts.map((text) => ({
        text,
      })),
    );

  return {
    client,
    provider: {
      embedBatch,
      embedBatchInputs,
      embedQuery,
      id: "gemini",
      maxInputTokens: GEMINI_MAX_INPUT_TOKENS[client.model],
      model: client.model,
    },
  };
}

export async function resolveGeminiEmbeddingClient(
  options: EmbeddingProviderOptions,
): Promise<GeminiEmbeddingClient> {
  const {remote} = options;
  const remoteApiKey = resolveRemoteApiKey(remote?.apiKey);
  const remoteBaseUrl = remote?.baseUrl?.trim();

  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          agentDir: options.agentDir,
          cfg: options.config,
          provider: "google",
        }),
        "google",
      );

  const providerConfig = options.config.models?.providers?.google;
  const rawBaseUrl =
    remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_GOOGLE_API_BASE_URL;
  const baseUrl = normalizeGeminiBaseUrl(rawBaseUrl);
  const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
  const headerOverrides = { ...providerConfig?.headers, ...remote?.headers};
  const headers: Record<string, string> = {
    ...headerOverrides,
  };
  const apiKeys = collectProviderApiKeysForExecution({
    primaryApiKey: apiKey,
    provider: "google",
  });
  const model = normalizeGeminiModel(options.model);
  const modelPath = buildGeminiModelPath(model);
  const outputDimensionality = resolveGeminiOutputDimensionality(
    model,
    options.outputDimensionality,
  );
  debugEmbeddingsLog("memory embeddings: gemini client", {
    baseUrl,
    batchEndpoint: `${baseUrl}/${modelPath}:batchEmbedContents`,
    embedEndpoint: `${baseUrl}/${modelPath}:embedContent`,
    model,
    modelPath,
    outputDimensionality,
    rawBaseUrl,
  });
  return { apiKeys, baseUrl, headers, model, modelPath, outputDimensionality, ssrfPolicy };
}
