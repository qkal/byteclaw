import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const KIMI_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_USER_AGENT = "claude-code/0.1.0";
export const KIMI_DEFAULT_MODEL_ID = "kimi-code";
export const KIMI_UPSTREAM_MODEL_ID = "kimi-for-coding";
export const KIMI_LEGACY_MODEL_ID = "k2p5";
const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262_144;
const KIMI_CODING_DEFAULT_MAX_TOKENS = 32_768;
const KIMI_CODING_DEFAULT_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
};

export function buildKimiCodingProvider(): ModelProviderConfig {
  return {
    api: "anthropic-messages",
    baseUrl: KIMI_BASE_URL,
    headers: {
      "User-Agent": KIMI_CODING_USER_AGENT,
    },
    models: [
      {
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        cost: KIMI_CODING_DEFAULT_COST,
        id: KIMI_DEFAULT_MODEL_ID,
        input: ["text", "image"],
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
        name: "Kimi Code",
        reasoning: true,
      },
      {
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        cost: KIMI_CODING_DEFAULT_COST,
        id: KIMI_LEGACY_MODEL_ID,
        input: ["text", "image"],
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
        name: "Kimi Code (legacy model id)",
        reasoning: true,
      },
    ],
  };
}

export const KIMI_CODING_BASE_URL = KIMI_BASE_URL;
export const KIMI_CODING_DEFAULT_MODEL_ID = KIMI_DEFAULT_MODEL_ID;
export const KIMI_CODING_LEGACY_MODEL_ID = KIMI_LEGACY_MODEL_ID;
export const buildKimiProvider = buildKimiCodingProvider;
