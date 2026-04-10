import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// DeepSeek V3.2 API pricing (per 1M tokens)
// https://api-docs.deepseek.com/quick_start/pricing
const DEEPSEEK_V3_2_COST = {
  cacheRead: 0.028,
  cacheWrite: 0,
  input: 0.28,
  output: 0.42,
};

export const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    compat: { supportsUsageInStreaming: true },
    contextWindow: 131_072,
    cost: DEEPSEEK_V3_2_COST,
    id: "deepseek-chat",
    input: ["text"],
    maxTokens: 8192,
    name: "DeepSeek Chat",
    reasoning: false,
  },
  {
    compat: { supportsUsageInStreaming: true },
    contextWindow: 131_072,
    cost: DEEPSEEK_V3_2_COST,
    id: "deepseek-reasoner",
    input: ["text"],
    maxTokens: 65_536,
    name: "DeepSeek Reasoner",
    reasoning: true,
  },
];

export function buildDeepSeekModelDefinition(
  model: (typeof DEEPSEEK_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
