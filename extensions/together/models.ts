import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const TOGETHER_BASE_URL = "https://api.together.xyz/v1";

export const TOGETHER_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    contextWindow: 202_752,
    cost: {
      cacheRead: 0.45,
      cacheWrite: 2,
      input: 0.45,
      output: 2,
    },
    id: "zai-org/GLM-4.7",
    input: ["text"],
    maxTokens: 8192,
    name: "GLM 4.7 Fp8",
    reasoning: false,
  },
  {
    contextWindow: 262_144,
    cost: {
      cacheRead: 0.5,
      cacheWrite: 2.8,
      input: 0.5,
      output: 2.8,
    },
    id: "moonshotai/Kimi-K2.5",
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "Kimi K2.5",
    reasoning: true,
  },
  {
    contextWindow: 131_072,
    cost: {
      cacheRead: 0.88,
      cacheWrite: 0.88,
      input: 0.88,
      output: 0.88,
    },
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    input: ["text"],
    maxTokens: 8192,
    name: "Llama 3.3 70B Instruct Turbo",
    reasoning: false,
  },
  {
    contextWindow: 10_000_000,
    cost: {
      cacheRead: 0.18,
      cacheWrite: 0.18,
      input: 0.18,
      output: 0.59,
    },
    id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "Llama 4 Scout 17B 16E Instruct",
    reasoning: false,
  },
  {
    contextWindow: 20_000_000,
    cost: {
      cacheRead: 0.27,
      cacheWrite: 0.27,
      input: 0.27,
      output: 0.85,
    },
    id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    input: ["text", "image"],
    maxTokens: 32_768,
    name: "Llama 4 Maverick 17B 128E Instruct FP8",
    reasoning: false,
  },
  {
    contextWindow: 131_072,
    cost: {
      cacheRead: 0.6,
      cacheWrite: 0.6,
      input: 0.6,
      output: 1.25,
    },
    id: "deepseek-ai/DeepSeek-V3.1",
    input: ["text"],
    maxTokens: 8192,
    name: "DeepSeek V3.1",
    reasoning: false,
  },
  {
    contextWindow: 131_072,
    cost: {
      cacheRead: 3,
      cacheWrite: 3,
      input: 3,
      output: 7,
    },
    id: "deepseek-ai/DeepSeek-R1",
    input: ["text"],
    maxTokens: 8192,
    name: "DeepSeek R1",
    reasoning: true,
  },
  {
    contextWindow: 262_144,
    cost: {
      cacheRead: 1,
      cacheWrite: 3,
      input: 1,
      output: 3,
    },
    id: "moonshotai/Kimi-K2-Instruct-0905",
    input: ["text"],
    maxTokens: 8192,
    name: "Kimi K2-Instruct 0905",
    reasoning: false,
  },
];

export function buildTogetherModelDefinition(
  model: (typeof TOGETHER_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    api: "openai-completions",
    contextWindow: model.contextWindow,
    cost: model.cost,
    id: model.id,
    input: model.input,
    maxTokens: model.maxTokens,
    name: model.name,
    reasoning: model.reasoning,
  };
}
