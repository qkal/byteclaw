import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const FIREWORKS_DEFAULT_MODEL_ID = "accounts/fireworks/routers/kimi-k2p5-turbo";
export const FIREWORKS_DEFAULT_CONTEXT_WINDOW = 256_000;
export const FIREWORKS_DEFAULT_MAX_TOKENS = 256_000;

const ZERO_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
} as const;

export function buildFireworksCatalogModels(): ModelDefinitionConfig[] {
  return [
    {
      id: FIREWORKS_DEFAULT_MODEL_ID,
      name: "Kimi K2.5 Turbo (Fire Pass)",
      reasoning: false, // Kimi K2.5 can expose reasoning in visible content on FirePass.
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
    },
  ];
}

export function buildFireworksProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: FIREWORKS_BASE_URL,
    models: buildFireworksCatalogModels(),
  };
}
