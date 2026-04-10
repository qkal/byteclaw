import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger, retryAsync } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const log = createSubsystemLogger("venice-models");

export const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
export const VENICE_DEFAULT_MODEL_ID = "kimi-k2-5";
export const VENICE_DEFAULT_MODEL_REF = `venice/${VENICE_DEFAULT_MODEL_ID}`;

export const VENICE_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

const VENICE_DEFAULT_CONTEXT_WINDOW = 128_000;
const VENICE_DEFAULT_MAX_TOKENS = 4096;
const VENICE_DISCOVERY_HARD_MAX_TOKENS = 131_072;
const VENICE_DISCOVERY_TIMEOUT_MS = 10_000;
const VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export const VENICE_MODEL_CATALOG = [
  {
    contextWindow: 128_000,
    id: "llama-3.3-70b",
    input: ["text"],
    maxTokens: 4096,
    name: "Llama 3.3 70B",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    id: "llama-3.2-3b",
    input: ["text"],
    maxTokens: 4096,
    name: "Llama 3.2 3B",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    id: "hermes-3-llama-3.1-405b",
    input: ["text"],
    maxTokens: 16_384,
    name: "Hermes 3 Llama 3.1 405B",
    privacy: "private",
    reasoning: false,
    supportsTools: false,
  },
  {
    contextWindow: 128_000,
    id: "qwen3-235b-a22b-thinking-2507",
    input: ["text"],
    maxTokens: 16_384,
    name: "Qwen3 235B Thinking",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 128_000,
    id: "qwen3-235b-a22b-instruct-2507",
    input: ["text"],
    maxTokens: 16_384,
    name: "Qwen3 235B Instruct",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 256_000,
    id: "qwen3-coder-480b-a35b-instruct",
    input: ["text"],
    maxTokens: 65_536,
    name: "Qwen3 Coder 480B",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 256_000,
    id: "qwen3-coder-480b-a35b-instruct-turbo",
    input: ["text"],
    maxTokens: 65_536,
    name: "Qwen3 Coder 480B Turbo",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 256_000,
    id: "qwen3-5-35b-a3b",
    input: ["text", "image"],
    maxTokens: 65_536,
    name: "Qwen3.5 35B A3B",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 256_000,
    id: "qwen3-next-80b",
    input: ["text"],
    maxTokens: 16_384,
    name: "Qwen3 Next 80B",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 256_000,
    id: "qwen3-vl-235b-a22b",
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "Qwen3 VL 235B (Vision)",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 32_000,
    id: "qwen3-4b",
    input: ["text"],
    maxTokens: 4096,
    name: "Venice Small (Qwen3 4B)",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 160_000,
    id: "deepseek-v3.2",
    input: ["text"],
    maxTokens: 32_768,
    name: "DeepSeek V3.2",
    privacy: "private",
    reasoning: true,
    supportsTools: false,
  },
  {
    contextWindow: 32_000,
    id: "venice-uncensored",
    input: ["text"],
    maxTokens: 4096,
    name: "Venice Uncensored (Dolphin-Mistral)",
    privacy: "private",
    reasoning: false,
    supportsTools: false,
  },
  {
    contextWindow: 128_000,
    id: "mistral-31-24b",
    input: ["text", "image"],
    maxTokens: 4096,
    name: "Venice Medium (Mistral)",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 198_000,
    id: "google-gemma-3-27b-it",
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "Google Gemma 3 27B Instruct",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    id: "openai-gpt-oss-120b",
    input: ["text"],
    maxTokens: 16_384,
    name: "OpenAI GPT OSS 120B",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    id: "nvidia-nemotron-3-nano-30b-a3b",
    input: ["text"],
    maxTokens: 16_384,
    name: "NVIDIA Nemotron 3 Nano 30B",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    id: "olafangensan-glm-4.7-flash-heretic",
    input: ["text"],
    maxTokens: 24_000,
    name: "GLM 4.7 Flash Heretic",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 198_000,
    id: "zai-org-glm-4.6",
    input: ["text"],
    maxTokens: 16_384,
    name: "GLM 4.6",
    privacy: "private",
    reasoning: false,
  },
  {
    contextWindow: 198_000,
    id: "zai-org-glm-4.7",
    input: ["text"],
    maxTokens: 16_384,
    name: "GLM 4.7",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 128_000,
    id: "zai-org-glm-4.7-flash",
    input: ["text"],
    maxTokens: 16_384,
    name: "GLM 4.7 Flash",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 198_000,
    id: "zai-org-glm-5",
    input: ["text"],
    maxTokens: 32_000,
    name: "GLM 5",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 256_000,
    id: "kimi-k2-5",
    input: ["text", "image"],
    maxTokens: 65_536,
    name: "Kimi K2.5",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 256_000,
    id: "kimi-k2-thinking",
    input: ["text"],
    maxTokens: 65_536,
    name: "Kimi K2 Thinking",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 198_000,
    id: "minimax-m21",
    input: ["text"],
    maxTokens: 32_768,
    name: "MiniMax M2.1",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 198_000,
    id: "minimax-m25",
    input: ["text"],
    maxTokens: 32_768,
    name: "MiniMax M2.5",
    privacy: "private",
    reasoning: true,
  },
  {
    contextWindow: 198_000,
    id: "claude-opus-4-5",
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "Claude Opus 4.5 (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 1_000_000,
    id: "claude-opus-4-6",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "Claude Opus 4.6 (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 198_000,
    id: "claude-sonnet-4-5",
    input: ["text", "image"],
    maxTokens: 64_000,
    name: "Claude Sonnet 4.5 (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 1_000_000,
    id: "claude-sonnet-4-6",
    input: ["text", "image"],
    maxTokens: 64_000,
    name: "Claude Sonnet 4.6 (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 256_000,
    id: "openai-gpt-52",
    input: ["text"],
    maxTokens: 65_536,
    name: "GPT-5.2 (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 256_000,
    id: "openai-gpt-52-codex",
    input: ["text", "image"],
    maxTokens: 65_536,
    name: "GPT-5.2 Codex (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 400_000,
    id: "openai-gpt-53-codex",
    input: ["text", "image"],
    maxTokens: 128_000,
    name: "GPT-5.3 Codex (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 1_000_000,
    id: "openai-gpt-54",
    input: ["text", "image"],
    maxTokens: 131_072,
    name: "GPT-5.4 (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 128_000,
    id: "openai-gpt-4o-2024-11-20",
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "GPT-4o (via Venice)",
    privacy: "anonymized",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    id: "openai-gpt-4o-mini-2024-07-18",
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "GPT-4o Mini (via Venice)",
    privacy: "anonymized",
    reasoning: false,
  },
  {
    contextWindow: 198_000,
    id: "gemini-3-pro-preview",
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "Gemini 3 Pro (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 1_000_000,
    id: "gemini-3-1-pro-preview",
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "Gemini 3.1 Pro (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 256_000,
    id: "gemini-3-flash-preview",
    input: ["text", "image"],
    maxTokens: 65_536,
    name: "Gemini 3 Flash (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 1_000_000,
    id: "grok-41-fast",
    input: ["text", "image"],
    maxTokens: 30_000,
    name: "Grok 4.1 Fast (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
  {
    contextWindow: 256_000,
    id: "grok-code-fast-1",
    input: ["text"],
    maxTokens: 10_000,
    name: "Grok Code Fast 1 (via Venice)",
    privacy: "anonymized",
    reasoning: true,
  },
] as const;

export type VeniceCatalogEntry = (typeof VENICE_MODEL_CATALOG)[number];

export function buildVeniceModelDefinition(entry: VeniceCatalogEntry): ModelDefinitionConfig {
  return {
    compat: {
      supportsUsageInStreaming: false,
      ...("supportsTools" in entry && !entry.supportsTools ? { supportsTools: false } : {}),
    },
    contextWindow: entry.contextWindow,
    cost: VENICE_DEFAULT_COST,
    id: entry.id,
    input: [...entry.input],
    maxTokens: entry.maxTokens,
    name: entry.name,
    reasoning: entry.reasoning,
  };
}

interface VeniceModelSpec {
  name: string;
  privacy: "private" | "anonymized";
  availableContextTokens?: number;
  maxCompletionTokens?: number;
  capabilities?: {
    supportsReasoning?: boolean;
    supportsVision?: boolean;
    supportsFunctionCalling?: boolean;
  };
}

interface VeniceModel {
  id: string;
  model_spec?: VeniceModelSpec;
}

interface VeniceModelsResponse {
  data: VeniceModel[];
}

class VeniceDiscoveryHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "VeniceDiscoveryHttpError";
    this.status = status;
  }
}

function staticVeniceModelDefinitions(): ModelDefinitionConfig[] {
  return VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition);
}

function hasRetryableNetworkCode(err: unknown): boolean {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      errors?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    const code =
      typeof candidate.code === "string"
        ? candidate.code
        : (typeof candidate.errno === "string"
          ? candidate.errno
          : undefined);
    if (code && VENICE_DISCOVERY_RETRYABLE_NETWORK_CODES.has(code)) {
      return true;
    }
    if (candidate.cause) {
      queue.push(candidate.cause);
    }
    if (Array.isArray(candidate.errors)) {
      queue.push(...candidate.errors);
    }
  }
  return false;
}

function isRetryableVeniceDiscoveryError(err: unknown): boolean {
  if (err instanceof VeniceDiscoveryHttpError) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  if (err instanceof TypeError && normalizeLowercaseStringOrEmpty(err.message) === "fetch failed") {
    return true;
  }
  return hasRetryableNetworkCode(err);
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveApiMaxCompletionTokens(params: {
  apiModel: VeniceModel;
  knownMaxTokens?: number;
}): number | undefined {
  const raw = normalizePositiveInt(params.apiModel.model_spec?.maxCompletionTokens);
  if (!raw) {
    return undefined;
  }
  const contextWindow = normalizePositiveInt(params.apiModel.model_spec?.availableContextTokens);
  const knownMaxTokens =
    typeof params.knownMaxTokens === "number" && Number.isFinite(params.knownMaxTokens)
      ? Math.floor(params.knownMaxTokens)
      : undefined;
  const hardCap = knownMaxTokens ?? VENICE_DISCOVERY_HARD_MAX_TOKENS;
  const fallbackContextWindow = knownMaxTokens ?? VENICE_DEFAULT_CONTEXT_WINDOW;
  return Math.min(raw, contextWindow ?? fallbackContextWindow, hardCap);
}

function resolveApiSupportsTools(apiModel: VeniceModel): boolean | undefined {
  const supportsFunctionCalling = apiModel.model_spec?.capabilities?.supportsFunctionCalling;
  return typeof supportsFunctionCalling === "boolean" ? supportsFunctionCalling : undefined;
}

export async function discoverVeniceModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return staticVeniceModelDefinitions();
  }

  try {
    const response = await retryAsync(
      async () => {
        const currentResponse = await fetch(`${VENICE_BASE_URL}/models`, {
          headers: {
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(VENICE_DISCOVERY_TIMEOUT_MS),
        });
        if (
          !currentResponse.ok &&
          VENICE_DISCOVERY_RETRYABLE_HTTP_STATUS.has(currentResponse.status)
        ) {
          throw new VeniceDiscoveryHttpError(currentResponse.status);
        }
        return currentResponse;
      },
      {
        attempts: 3,
        jitter: 0.2,
        label: "venice-model-discovery",
        maxDelayMs: 2000,
        minDelayMs: 300,
        shouldRetry: isRetryableVeniceDiscoveryError,
      },
    );

    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return staticVeniceModelDefinitions();
    }

    const data = (await response.json()) as VeniceModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No models found from API, using static catalog");
      return staticVeniceModelDefinitions();
    }

    const catalogById = new Map<string, VeniceCatalogEntry>(
      VENICE_MODEL_CATALOG.map((m) => [m.id, m]),
    );
    const models: ModelDefinitionConfig[] = [];

    for (const apiModel of data.data) {
      const catalogEntry = catalogById.get(apiModel.id);
      const apiMaxTokens = resolveApiMaxCompletionTokens({
        apiModel,
        knownMaxTokens: catalogEntry?.maxTokens,
      });
      const apiSupportsTools = resolveApiSupportsTools(apiModel);
      if (catalogEntry) {
        const definition = buildVeniceModelDefinition(catalogEntry);
        if (apiMaxTokens !== undefined) {
          definition.maxTokens = apiMaxTokens;
        }
        if (apiSupportsTools === false) {
          definition.compat = {
            ...definition.compat,
            supportsTools: false,
          };
        }
        models.push(definition);
      } else {
        const apiSpec = apiModel.model_spec;
        const lowerModelId = normalizeLowercaseStringOrEmpty(apiModel.id);
        const isReasoning =
          apiSpec?.capabilities?.supportsReasoning ||
          lowerModelId.includes("thinking") ||
          lowerModelId.includes("reason") ||
          lowerModelId.includes("r1");

        const hasVision = apiSpec?.capabilities?.supportsVision === true;

        models.push({
          compat: {
            supportsUsageInStreaming: false,
            ...(apiSupportsTools === false ? { supportsTools: false } : {}),
          },
          contextWindow:
            normalizePositiveInt(apiSpec?.availableContextTokens) ?? VENICE_DEFAULT_CONTEXT_WINDOW,
          cost: VENICE_DEFAULT_COST,
          id: apiModel.id,
          input: hasVision ? ["text", "image"] : ["text"],
          maxTokens: apiMaxTokens ?? VENICE_DEFAULT_MAX_TOKENS,
          name: apiSpec?.name || apiModel.id,
          reasoning: isReasoning,
        });
      }
    }

    return models.length > 0 ? models : staticVeniceModelDefinitions();
  } catch (error) {
    if (error instanceof VeniceDiscoveryHttpError) {
      log.warn(`Failed to discover models: HTTP ${error.status}, using static catalog`);
      return staticVeniceModelDefinitions();
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticVeniceModelDefinitions();
  }
}
