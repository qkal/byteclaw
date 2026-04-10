import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

const log = createSubsystemLogger("chutes-models");

export const CHUTES_BASE_URL = "https://llm.chutes.ai/v1";
export const CHUTES_DEFAULT_MODEL_ID = "zai-org/GLM-4.7-TEE";
export const CHUTES_DEFAULT_MODEL_REF = `chutes/${CHUTES_DEFAULT_MODEL_ID}`;

const CHUTES_DEFAULT_CONTEXT_WINDOW = 128_000;
const CHUTES_DEFAULT_MAX_TOKENS = 4096;

export const CHUTES_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    contextWindow: 40_960,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.08, output: 0.24 },
    id: "Qwen/Qwen3-32B",
    input: ["text"],
    maxTokens: 40_960,
    name: "Qwen/Qwen3-32B",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.02, output: 0.04 },
    id: "unsloth/Mistral-Nemo-Instruct-2407",
    input: ["text"],
    maxTokens: 131_072,
    name: "unsloth/Mistral-Nemo-Instruct-2407",
    reasoning: false,
  },
  {
    contextWindow: 163_840,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.25, output: 1 },
    id: "deepseek-ai/DeepSeek-V3-0324-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "deepseek-ai/DeepSeek-V3-0324-TEE",
    reasoning: true,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.08, output: 0.55 },
    id: "Qwen/Qwen3-235B-A22B-Instruct-2507-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "Qwen/Qwen3-235B-A22B-Instruct-2507-TEE",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.05, output: 0.45 },
    id: "openai/gpt-oss-120b-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "openai/gpt-oss-120b-TEE",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.03, output: 0.11 },
    id: "chutesai/Mistral-Small-3.1-24B-Instruct-2503",
    input: ["text", "image"],
    maxTokens: 131_072,
    name: "chutesai/Mistral-Small-3.1-24B-Instruct-2503",
    reasoning: false,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.28, output: 0.42 },
    id: "deepseek-ai/DeepSeek-V3.2-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "deepseek-ai/DeepSeek-V3.2-TEE",
    reasoning: true,
  },
  {
    contextWindow: 202_752,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.4, output: 2 },
    id: "zai-org/GLM-4.7-TEE",
    input: ["text"],
    maxTokens: 65_535,
    name: "zai-org/GLM-4.7-TEE",
    reasoning: true,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.45, output: 2.2 },
    id: "moonshotai/Kimi-K2.5-TEE",
    input: ["text", "image"],
    maxTokens: 65_535,
    name: "moonshotai/Kimi-K2.5-TEE",
    reasoning: true,
  },
  {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.04, output: 0.15 },
    id: "unsloth/gemma-3-27b-it",
    input: ["text", "image"],
    maxTokens: 65_536,
    name: "unsloth/gemma-3-27b-it",
    reasoning: false,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.09, output: 0.29 },
    id: "XiaomiMiMo/MiMo-V2-Flash-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "XiaomiMiMo/MiMo-V2-Flash-TEE",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.06, output: 0.18 },
    id: "chutesai/Mistral-Small-3.2-24B-Instruct-2506",
    input: ["text", "image"],
    maxTokens: 131_072,
    name: "chutesai/Mistral-Small-3.2-24B-Instruct-2506",
    reasoning: false,
  },
  {
    contextWindow: 163_840,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.45, output: 2.15 },
    id: "deepseek-ai/DeepSeek-R1-0528-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "deepseek-ai/DeepSeek-R1-0528-TEE",
    reasoning: true,
  },
  {
    contextWindow: 202_752,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.95, output: 3.15 },
    id: "zai-org/GLM-5-TEE",
    input: ["text"],
    maxTokens: 65_535,
    name: "zai-org/GLM-5-TEE",
    reasoning: true,
  },
  {
    contextWindow: 163_840,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.2, output: 0.8 },
    id: "deepseek-ai/DeepSeek-V3.1-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "deepseek-ai/DeepSeek-V3.1-TEE",
    reasoning: true,
  },
  {
    contextWindow: 163_840,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.23, output: 0.9 },
    id: "deepseek-ai/DeepSeek-V3.1-Terminus-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "deepseek-ai/DeepSeek-V3.1-Terminus-TEE",
    reasoning: true,
  },
  {
    contextWindow: 96_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.03 },
    id: "unsloth/gemma-3-4b-it",
    input: ["text", "image"],
    maxTokens: 96_000,
    name: "unsloth/gemma-3-4b-it",
    reasoning: false,
  },
  {
    contextWindow: 196_608,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 1.1 },
    id: "MiniMaxAI/MiniMax-M2.5-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "MiniMaxAI/MiniMax-M2.5-TEE",
    reasoning: true,
  },
  {
    contextWindow: 163_840,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.25, output: 0.85 },
    id: "tngtech/DeepSeek-TNG-R1T2-Chimera",
    input: ["text"],
    maxTokens: 163_840,
    name: "tngtech/DeepSeek-TNG-R1T2-Chimera",
    reasoning: true,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.12, output: 0.75 },
    id: "Qwen/Qwen3-Coder-Next-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "Qwen/Qwen3-Coder-Next-TEE",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 1.2 },
    id: "NousResearch/Hermes-4-405B-FP8-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "NousResearch/Hermes-4-405B-FP8-TEE",
    reasoning: true,
  },
  {
    contextWindow: 163_840,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 1.2 },
    id: "deepseek-ai/DeepSeek-V3",
    input: ["text"],
    maxTokens: 163_840,
    name: "deepseek-ai/DeepSeek-V3",
    reasoning: false,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.04, output: 0.15 },
    id: "openai/gpt-oss-20b",
    input: ["text"],
    maxTokens: 131_072,
    name: "openai/gpt-oss-20b",
    reasoning: true,
  },
  {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.01 },
    id: "unsloth/Llama-3.2-3B-Instruct",
    input: ["text"],
    maxTokens: 4096,
    name: "unsloth/Llama-3.2-3B-Instruct",
    reasoning: false,
  },
  {
    contextWindow: 32_768,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.07, output: 0.3 },
    id: "unsloth/Mistral-Small-24B-Instruct-2501",
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "unsloth/Mistral-Small-24B-Instruct-2501",
    reasoning: false,
  },
  {
    contextWindow: 202_752,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 1.2 },
    id: "zai-org/GLM-4.7-FP8",
    input: ["text"],
    maxTokens: 65_535,
    name: "zai-org/GLM-4.7-FP8",
    reasoning: true,
  },
  {
    contextWindow: 202_752,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.4, output: 1.7 },
    id: "zai-org/GLM-4.6-TEE",
    input: ["text"],
    maxTokens: 65_536,
    name: "zai-org/GLM-4.6-TEE",
    reasoning: true,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.55, output: 3.5 },
    id: "Qwen/Qwen3.5-397B-A17B-TEE",
    input: ["text", "image"],
    maxTokens: 65_536,
    name: "Qwen/Qwen3.5-397B-A17B-TEE",
    reasoning: true,
  },
  {
    contextWindow: 32_768,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 1.2 },
    id: "Qwen/Qwen2.5-72B-Instruct",
    input: ["text"],
    maxTokens: 32_768,
    name: "Qwen/Qwen2.5-72B-Instruct",
    reasoning: false,
  },
  {
    contextWindow: 32_768,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.02, output: 0.1 },
    id: "NousResearch/DeepHermes-3-Mistral-24B-Preview",
    input: ["text"],
    maxTokens: 32_768,
    name: "NousResearch/DeepHermes-3-Mistral-24B-Preview",
    reasoning: false,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.1, output: 0.8 },
    id: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    input: ["text"],
    maxTokens: 262_144,
    name: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    reasoning: false,
  },
  {
    contextWindow: 202_752,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 1.2 },
    id: "zai-org/GLM-4.6-FP8",
    input: ["text"],
    maxTokens: 65_535,
    name: "zai-org/GLM-4.6-FP8",
    reasoning: true,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.11, output: 0.6 },
    id: "Qwen/Qwen3-235B-A22B-Thinking-2507",
    input: ["text"],
    maxTokens: 262_144,
    name: "Qwen/Qwen3-235B-A22B-Thinking-2507",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.03, output: 0.11 },
    id: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
    input: ["text"],
    maxTokens: 131_072,
    name: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.22, output: 0.6 },
    id: "tngtech/R1T2-Chimera-Speed",
    input: ["text"],
    maxTokens: 65_536,
    name: "tngtech/R1T2-Chimera-Speed",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 0.9 },
    id: "zai-org/GLM-4.6V",
    input: ["text", "image"],
    maxTokens: 65_536,
    name: "zai-org/GLM-4.6V",
    reasoning: true,
  },
  {
    contextWindow: 16_384,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.05, output: 0.22 },
    id: "Qwen/Qwen2.5-VL-32B-Instruct",
    input: ["text", "image"],
    maxTokens: 16_384,
    name: "Qwen/Qwen2.5-VL-32B-Instruct",
    reasoning: false,
  },
  {
    contextWindow: 262_144,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 1.2 },
    id: "Qwen/Qwen3-VL-235B-A22B-Instruct",
    input: ["text", "image"],
    maxTokens: 262_144,
    name: "Qwen/Qwen3-VL-235B-A22B-Instruct",
    reasoning: false,
  },
  {
    contextWindow: 40_960,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.05, output: 0.22 },
    id: "Qwen/Qwen3-14B",
    input: ["text"],
    maxTokens: 40_960,
    name: "Qwen/Qwen3-14B",
    reasoning: true,
  },
  {
    contextWindow: 32_768,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.03, output: 0.11 },
    id: "Qwen/Qwen2.5-Coder-32B-Instruct",
    input: ["text"],
    maxTokens: 32_768,
    name: "Qwen/Qwen2.5-Coder-32B-Instruct",
    reasoning: false,
  },
  {
    contextWindow: 40_960,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.06, output: 0.22 },
    id: "Qwen/Qwen3-30B-A3B",
    input: ["text"],
    maxTokens: 40_960,
    name: "Qwen/Qwen3-30B-A3B",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.03, output: 0.1 },
    id: "unsloth/gemma-3-12b-it",
    input: ["text", "image"],
    maxTokens: 131_072,
    name: "unsloth/gemma-3-12b-it",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.01 },
    id: "unsloth/Llama-3.2-1B-Instruct",
    input: ["text"],
    maxTokens: 4096,
    name: "unsloth/Llama-3.2-1B-Instruct",
    reasoning: false,
  },
  {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.3, output: 1.2 },
    id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16-TEE",
    input: ["text"],
    maxTokens: 4096,
    name: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16-TEE",
    reasoning: true,
  },
  {
    contextWindow: 40_960,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.05 },
    id: "NousResearch/Hermes-4-14B",
    input: ["text"],
    maxTokens: 40_960,
    name: "NousResearch/Hermes-4-14B",
    reasoning: true,
  },
  {
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.01 },
    id: "Qwen/Qwen3Guard-Gen-0.6B",
    input: ["text"],
    maxTokens: 4096,
    name: "Qwen/Qwen3Guard-Gen-0.6B",
    reasoning: false,
  },
  {
    contextWindow: 131_072,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0.01, output: 0.01 },
    id: "rednote-hilab/dots.ocr",
    input: ["text", "image"],
    maxTokens: 131_072,
    name: "rednote-hilab/dots.ocr",
    reasoning: false,
  },
];

export function buildChutesModelDefinition(
  model: (typeof CHUTES_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    compat: {
      supportsUsageInStreaming: false,
    },
  };
}

interface ChutesModelEntry {
  id: string;
  name?: string;
  supported_features?: string[];
  input_modalities?: string[];
  context_length?: number;
  max_output_length?: number;
  pricing?: {
    prompt?: number;
    completion?: number;
  };
  [key: string]: unknown;
}

interface OpenAIListModelsResponse {
  data?: ChutesModelEntry[];
}

const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;

interface CacheEntry {
  models: ModelDefinitionConfig[];
  time: number;
}

const modelCache = new Map<string, CacheEntry>();

export function clearChutesModelCacheForTests(): void {
  modelCache.clear();
}

function pruneExpiredCacheEntries(now: number = Date.now()): void {
  for (const [key, entry] of modelCache.entries()) {
    if (now - entry.time >= CACHE_TTL) {
      modelCache.delete(key);
    }
  }
}

function cacheAndReturn(
  tokenKey: string,
  models: ModelDefinitionConfig[],
): ModelDefinitionConfig[] {
  const now = Date.now();
  pruneExpiredCacheEntries(now);

  if (!modelCache.has(tokenKey) && modelCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = modelCache.keys().next();
    if (!oldest.done) {
      modelCache.delete(oldest.value);
    }
  }

  modelCache.set(tokenKey, { models, time: now });
  return models;
}

export async function discoverChutesModels(accessToken?: string): Promise<ModelDefinitionConfig[]> {
  const trimmedKey = normalizeOptionalString(accessToken) ?? "";
  const now = Date.now();
  pruneExpiredCacheEntries(now);
  const cached = modelCache.get(trimmedKey);
  if (cached) {
    return cached.models;
  }

  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
    return CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition);
  }

  let effectiveKey = trimmedKey;
  const staticCatalog = () =>
    cacheAndReturn(effectiveKey, CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition));

  const headers: Record<string, string> = {};
  if (trimmedKey) {
    headers.Authorization = `Bearer ${trimmedKey}`;
  }

  try {
    let response = await fetch(`${CHUTES_BASE_URL}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401 && trimmedKey) {
      effectiveKey = "";
      response = await fetch(`${CHUTES_BASE_URL}/models`, {
        signal: AbortSignal.timeout(10_000),
      });
    }

    if (!response.ok) {
      if (response.status !== 401 && response.status !== 503) {
        log.warn(`GET /v1/models failed: HTTP ${response.status}, using static catalog`);
      }
      return staticCatalog();
    }

    const body = (await response.json()) as OpenAIListModelsResponse;
    const data = body?.data;
    if (!Array.isArray(data) || data.length === 0) {
      log.warn("No models in response, using static catalog");
      return staticCatalog();
    }

    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of data) {
      const id = normalizeOptionalString(entry?.id) ?? "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);

      const lowerId = normalizeLowercaseStringOrEmpty(id);
      const isReasoning =
        entry.supported_features?.includes("reasoning") ||
        lowerId.includes("r1") ||
        lowerId.includes("thinking") ||
        lowerId.includes("reason") ||
        lowerId.includes("tee");

      const input: ("text" | "image")[] = (entry.input_modalities || ["text"]).filter(
        (i): i is "text" | "image" => i === "text" || i === "image",
      );

      models.push({
        compat: {
          supportsUsageInStreaming: false,
        },
        contextWindow: entry.context_length || CHUTES_DEFAULT_CONTEXT_WINDOW,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: entry.pricing?.prompt || 0,
          output: entry.pricing?.completion || 0,
        },
        id,
        input,
        maxTokens: entry.max_output_length || CHUTES_DEFAULT_MAX_TOKENS,
        name: id,
        reasoning: isReasoning,
      });
    }

    return cacheAndReturn(
      effectiveKey,
      models.length > 0 ? models : CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition),
    );
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticCatalog();
  }
}
