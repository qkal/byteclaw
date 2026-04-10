import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_DEFAULT_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b";
const NVIDIA_DEFAULT_MAX_TOKENS = 8192;
const NVIDIA_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

export function buildNvidiaProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: NVIDIA_BASE_URL,
    models: [
      {
        contextWindow: 262144,
        cost: NVIDIA_DEFAULT_COST,
        id: NVIDIA_DEFAULT_MODEL_ID,
        input: ["text"],
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
        name: "NVIDIA Nemotron 3 Super 120B",
        reasoning: false,
      },
      {
        contextWindow: 262144,
        cost: NVIDIA_DEFAULT_COST,
        id: "moonshotai/kimi-k2.5",
        input: ["text"],
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
        name: "Kimi K2.5",
        reasoning: false,
      },
      {
        contextWindow: 196608,
        cost: NVIDIA_DEFAULT_COST,
        id: "minimaxai/minimax-m2.5",
        input: ["text"],
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
        name: "MiniMax M2.5",
        reasoning: false,
      },
      {
        contextWindow: 202752,
        cost: NVIDIA_DEFAULT_COST,
        id: "z-ai/glm5",
        input: ["text"],
        maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
        name: "GLM-5",
        reasoning: false,
      },
    ],
  };
}
