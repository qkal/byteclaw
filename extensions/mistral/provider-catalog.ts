import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { MISTRAL_BASE_URL, buildMistralCatalogModels } from "./model-definitions.js";

export function buildMistralProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: MISTRAL_BASE_URL,
    models: buildMistralCatalogModels(),
  };
}
