import fsSync from "node:fs";
import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  type MemoryEmbeddingProviderAdapter,
  OPENAI_BATCH_ENDPOINT,
  buildGeminiEmbeddingRequest,
  createGeminiEmbeddingProvider,
  createLocalEmbeddingProvider,
  createMistralEmbeddingProvider,
  createOpenAiEmbeddingProvider,
  createVoyageEmbeddingProvider,
  hasNonTextEmbeddingParts,
  listRegisteredMemoryEmbeddingProviderAdapters,
  runGeminiEmbeddingBatches,
  runOpenAiEmbeddingBatches,
  runVoyageEmbeddingBatches,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { getProviderEnvVars } from "openclaw/plugin-sdk/provider-env-vars";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { formatErrorMessage } from "../dreaming-shared.js";
import { filterUnregisteredMemoryEmbeddingProviderAdapters } from "./provider-adapter-registration.js";

export interface BuiltinMemoryEmbeddingProviderDoctorMetadata {
  providerId: string;
  authProviderId: string;
  envVars: string[];
  transport: "local" | "remote";
  autoSelectPriority?: number;
}

function isMissingApiKeyError(err: unknown): boolean {
  return formatErrorMessage(err).includes("No API key found for provider");
}

function sanitizeHeaders(
  headers: Record<string, string>,
  excludedHeaderNames: string[],
): [string, string][] {
  const excluded = new Set(
    excludedHeaderNames.map((name) => normalizeLowercaseStringOrEmpty(name)),
  );
  return Object.entries(headers)
    .filter(([key]) => !excluded.has(normalizeLowercaseStringOrEmpty(key)))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value]);
}

function mapBatchEmbeddingsByIndex(byCustomId: Map<string, number[]>, count: number): number[][] {
  const embeddings: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    embeddings.push(byCustomId.get(String(index)) ?? []);
  }
  return embeddings;
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const { code } = err as Error & { code?: unknown };
  return code === "ERR_MODULE_NOT_FOUND" && err.message.includes("node-llama-cpp");
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatErrorMessage(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local embeddings:",
    "1) Use Node 24 (recommended for installs/updates; Node 22 LTS, currently 22.14+, remains supported)",
    missing
      ? "2) Reinstall OpenClaw (this should install node-llama-cpp): npm i -g openclaw@latest"
      : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    ...["openai", "gemini", "voyage", "mistral"].map(
      (provider) => `Or set agents.defaults.memorySearch.provider = "${provider}" (remote).`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

function canAutoSelectLocal(modelPath?: string): boolean {
  const trimmed = modelPath?.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(hf:|https?:)/i.test(trimmed)) {
    return false;
  }
  const resolved = resolveUserPath(trimmed);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function supportsGeminiMultimodalEmbeddings(model: string): boolean {
  const normalized = model
    .trim()
    .replace(/^models\//, "")
    .replace(/^(gemini|google)\//, "");
  return normalized === "gemini-embedding-2-preview";
}

function resolveMemoryEmbeddingAuthProviderId(providerId: string): string {
  return providerId === "gemini" ? "google" : providerId;
}

const openAiAdapter: MemoryEmbeddingProviderAdapter = {
  allowExplicitWhenConfiguredAuto: true,
  autoSelectPriority: 20,
  create: async (options) => {
    const { provider, client } = await createOpenAiEmbeddingProvider({
      ...options,
      fallback: "none",
      provider: "openai",
    });
    return {
      provider,
      runtime: {
        batchEmbed: async (batch) => {
          const byCustomId = await runOpenAiEmbeddingBatches({
            openAi: client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              method: "POST",
              url: OPENAI_BATCH_ENDPOINT,
              body: {
                model: client.model,
                input: chunk.text,
              },
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
        cacheKeyData: {
          baseUrl: client.baseUrl,
          headers: sanitizeHeaders(client.headers, ["authorization"]),
          model: client.model,
          provider: "openai",
        },
        id: "openai",
      },
    };
  },
  defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
  id: "openai",
  shouldContinueAutoSelection: isMissingApiKeyError,
  transport: "remote",
};

const geminiAdapter: MemoryEmbeddingProviderAdapter = {
  allowExplicitWhenConfiguredAuto: true,
  autoSelectPriority: 30,
  create: async (options) => {
    const { provider, client } = await createGeminiEmbeddingProvider({
      ...options,
      fallback: "none",
      provider: "gemini",
    });
    return {
      provider,
      runtime: {
        batchEmbed: async (batch) => {
          if (batch.chunks.some((chunk) => hasNonTextEmbeddingParts(chunk.embeddingInput))) {
            return null;
          }
          const byCustomId = await runGeminiEmbeddingBatches({
            gemini: client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              request: buildGeminiEmbeddingRequest({
                input: chunk.embeddingInput ?? { text: chunk.text },
                taskType: "RETRIEVAL_DOCUMENT",
                modelPath: client.modelPath,
                outputDimensionality: client.outputDimensionality,
              }),
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
        cacheKeyData: {
          baseUrl: client.baseUrl,
          headers: sanitizeHeaders(client.headers, ["authorization", "x-goog-api-key"]),
          model: client.model,
          outputDimensionality: client.outputDimensionality,
          provider: "gemini",
        },
        id: "gemini",
      },
    };
  },
  defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
  id: "gemini",
  shouldContinueAutoSelection: isMissingApiKeyError,
  supportsMultimodalEmbeddings: ({ model }) => supportsGeminiMultimodalEmbeddings(model),
  transport: "remote",
};

const voyageAdapter: MemoryEmbeddingProviderAdapter = {
  allowExplicitWhenConfiguredAuto: true,
  autoSelectPriority: 40,
  create: async (options) => {
    const { provider, client } = await createVoyageEmbeddingProvider({
      ...options,
      fallback: "none",
      provider: "voyage",
    });
    return {
      provider,
      runtime: {
        batchEmbed: async (batch) => {
          const byCustomId = await runVoyageEmbeddingBatches({
            client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              body: {
                input: chunk.text,
              },
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
        id: "voyage",
      },
    };
  },
  defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
  id: "voyage",
  shouldContinueAutoSelection: isMissingApiKeyError,
  transport: "remote",
};

const mistralAdapter: MemoryEmbeddingProviderAdapter = {
  allowExplicitWhenConfiguredAuto: true,
  autoSelectPriority: 50,
  create: async (options) => {
    const { provider, client } = await createMistralEmbeddingProvider({
      ...options,
      fallback: "none",
      provider: "mistral",
    });
    return {
      provider,
      runtime: {
        cacheKeyData: {
          model: client.model,
          provider: "mistral",
        },
        id: "mistral",
      },
    };
  },
  defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
  id: "mistral",
  shouldContinueAutoSelection: isMissingApiKeyError,
  transport: "remote",
};

const localAdapter: MemoryEmbeddingProviderAdapter = {
  autoSelectPriority: 10,
  create: async (options) => {
    const provider = await createLocalEmbeddingProvider({
      ...options,
      fallback: "none",
      provider: "local",
    });
    return {
      provider,
      runtime: {
        cacheKeyData: {
          model: provider.model,
          provider: "local",
        },
        id: "local",
      },
    };
  },
  defaultModel: DEFAULT_LOCAL_MODEL,
  formatSetupError: formatLocalSetupError,
  id: "local",
  shouldContinueAutoSelection: () => true,
  transport: "local",
};

export const builtinMemoryEmbeddingProviderAdapters = [
  localAdapter,
  openAiAdapter,
  geminiAdapter,
  voyageAdapter,
  mistralAdapter,
] as const;

const builtinMemoryEmbeddingProviderAdapterById = new Map(
  builtinMemoryEmbeddingProviderAdapters.map((adapter) => [adapter.id, adapter]),
);

export function getBuiltinMemoryEmbeddingProviderAdapter(
  id: string,
): MemoryEmbeddingProviderAdapter | undefined {
  return builtinMemoryEmbeddingProviderAdapterById.get(id);
}

export function registerBuiltInMemoryEmbeddingProviders(register: {
  registerMemoryEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
}): void {
  // Only inspect providers already registered in the current load. Falling back
  // To capability discovery here can recursively trigger plugin loading while
  // Memory-core itself is still registering.
  for (const adapter of filterUnregisteredMemoryEmbeddingProviderAdapters({
    builtinAdapters: builtinMemoryEmbeddingProviderAdapters,
    registeredAdapters: listRegisteredMemoryEmbeddingProviderAdapters(),
  })) {
    register.registerMemoryEmbeddingProvider(adapter);
  }
}

export function getBuiltinMemoryEmbeddingProviderDoctorMetadata(
  providerId: string,
): BuiltinMemoryEmbeddingProviderDoctorMetadata | null {
  const adapter = getBuiltinMemoryEmbeddingProviderAdapter(providerId);
  if (!adapter) {
    return null;
  }
  const authProviderId = resolveMemoryEmbeddingAuthProviderId(adapter.id);
  return {
    authProviderId,
    autoSelectPriority: adapter.autoSelectPriority,
    envVars: getProviderEnvVars(authProviderId),
    providerId: adapter.id,
    transport: adapter.transport === "local" ? "local" : "remote",
  };
}

export function listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata(): BuiltinMemoryEmbeddingProviderDoctorMetadata[] {
  return builtinMemoryEmbeddingProviderAdapters
    .filter((adapter) => typeof adapter.autoSelectPriority === "number")
    .toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0))
    .map((adapter) => ({
      authProviderId: resolveMemoryEmbeddingAuthProviderId(adapter.id),
      autoSelectPriority: adapter.autoSelectPriority,
      envVars: getProviderEnvVars(resolveMemoryEmbeddingAuthProviderId(adapter.id)),
      providerId: adapter.id,
      transport: adapter.transport === "local" ? "local" : "remote",
    }));
}

export {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  canAutoSelectLocal,
  formatLocalSetupError,
  isMissingApiKeyError,
};
