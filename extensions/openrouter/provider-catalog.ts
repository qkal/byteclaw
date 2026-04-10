import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL_ID = "auto";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 200_000;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

export function buildOpenrouterProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: OPENROUTER_BASE_URL,
    models: [
      {
        contextWindow: OPENROUTER_DEFAULT_CONTEXT_WINDOW,
        cost: OPENROUTER_DEFAULT_COST,
        id: OPENROUTER_DEFAULT_MODEL_ID,
        input: ["text", "image"],
        maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS,
        name: "OpenRouter Auto",
        reasoning: false,
      },
      {
        contextWindow: 1048576,
        cost: OPENROUTER_DEFAULT_COST,
        id: "openrouter/hunter-alpha",
        input: ["text"],
        maxTokens: 65536,
        name: "Hunter Alpha",
        reasoning: true,
      },
      {
        contextWindow: 262144,
        cost: OPENROUTER_DEFAULT_COST,
        id: "openrouter/healer-alpha",
        input: ["text", "image"],
        maxTokens: 65536,
        name: "Healer Alpha",
        reasoning: true,
      },
    ],
  };
}
