import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/v1";
export const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
const XIAOMI_DEFAULT_CONTEXT_WINDOW = 262_144;
const XIAOMI_DEFAULT_MAX_TOKENS = 8192;
const XIAOMI_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

export function buildXiaomiProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: XIAOMI_BASE_URL,
    models: [
      {
        contextWindow: XIAOMI_DEFAULT_CONTEXT_WINDOW,
        cost: XIAOMI_DEFAULT_COST,
        id: XIAOMI_DEFAULT_MODEL_ID,
        input: ["text"],
        maxTokens: XIAOMI_DEFAULT_MAX_TOKENS,
        name: "Xiaomi MiMo V2 Flash",
        reasoning: false,
      },
      {
        contextWindow: 1048576,
        cost: XIAOMI_DEFAULT_COST,
        id: "mimo-v2-pro",
        input: ["text"],
        maxTokens: 32000,
        name: "Xiaomi MiMo V2 Pro",
        reasoning: true,
      },
      {
        contextWindow: XIAOMI_DEFAULT_CONTEXT_WINDOW,
        cost: XIAOMI_DEFAULT_COST,
        id: "mimo-v2-omni",
        input: ["text", "image"],
        maxTokens: 32000,
        name: "Xiaomi MiMo V2 Omni",
        reasoning: true,
      },
    ],
  };
}
