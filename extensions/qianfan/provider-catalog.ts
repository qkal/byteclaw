import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
export const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
const QIANFAN_DEFAULT_CONTEXT_WINDOW = 98_304;
const QIANFAN_DEFAULT_MAX_TOKENS = 32_768;
const QIANFAN_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

export function buildQianfanProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: QIANFAN_BASE_URL,
    models: [
      {
        contextWindow: QIANFAN_DEFAULT_CONTEXT_WINDOW,
        cost: QIANFAN_DEFAULT_COST,
        id: QIANFAN_DEFAULT_MODEL_ID,
        input: ["text"],
        maxTokens: QIANFAN_DEFAULT_MAX_TOKENS,
        name: "DEEPSEEK V3.2",
        reasoning: true,
      },
      {
        contextWindow: 119000,
        cost: QIANFAN_DEFAULT_COST,
        id: "ernie-5.0-thinking-preview",
        input: ["text", "image"],
        maxTokens: 64000,
        name: "ERNIE-5.0-Thinking-Preview",
        reasoning: true,
      },
    ],
  };
}
