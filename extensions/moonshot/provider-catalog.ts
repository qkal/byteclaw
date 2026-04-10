import {
  applyProviderNativeStreamingUsageCompat,
  supportsNativeStreamingUsageCompat,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
export const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 262_144;
const MOONSHOT_DEFAULT_MAX_TOKENS = 262_144;
const MOONSHOT_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

const MOONSHOT_MODEL_CATALOG = [
  {
    contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
    cost: MOONSHOT_DEFAULT_COST,
    id: "kimi-k2.5",
    input: ["text", "image"],
    maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
    name: "Kimi K2.5",
    reasoning: false,
  },
  {
    contextWindow: 262_144,
    cost: MOONSHOT_DEFAULT_COST,
    id: "kimi-k2-thinking",
    input: ["text"],
    maxTokens: 262_144,
    name: "Kimi K2 Thinking",
    reasoning: true,
  },
  {
    contextWindow: 262_144,
    cost: MOONSHOT_DEFAULT_COST,
    id: "kimi-k2-thinking-turbo",
    input: ["text"],
    maxTokens: 262_144,
    name: "Kimi K2 Thinking Turbo",
    reasoning: true,
  },
  {
    contextWindow: 256_000,
    cost: MOONSHOT_DEFAULT_COST,
    id: "kimi-k2-turbo",
    input: ["text"],
    maxTokens: 16_384,
    name: "Kimi K2 Turbo",
    reasoning: false,
  },
] as const;

export function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  return supportsNativeStreamingUsageCompat({
    baseUrl,
    providerId: "moonshot",
  });
}

export function applyMoonshotNativeStreamingUsageCompat(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  return applyProviderNativeStreamingUsageCompat({
    providerConfig: provider,
    providerId: "moonshot",
  });
}

export function buildMoonshotProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: MOONSHOT_BASE_URL,
    models: MOONSHOT_MODEL_CATALOG.map((model) => ({ ...model, input: [...model.input] })),
  };
}
