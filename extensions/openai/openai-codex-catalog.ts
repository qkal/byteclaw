import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export function buildOpenAICodexProvider(): ModelProviderConfig {
  return {
    api: "openai-codex-responses",
    baseUrl: OPENAI_CODEX_BASE_URL,
    models: [],
  };
}
