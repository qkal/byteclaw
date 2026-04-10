import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { QWEN_BASE_URL, buildQwenModelCatalogForBaseUrl } from "./models.js";

export function buildQwenProvider(params?: { baseUrl?: string }): ModelProviderConfig {
  const baseUrl = params?.baseUrl ?? QWEN_BASE_URL;
  return {
    api: "openai-completions",
    baseUrl,
    models: buildQwenModelCatalogForBaseUrl(baseUrl).map((model) => ({ ...model })),
  };
}

export const buildModelStudioProvider = buildQwenProvider;
