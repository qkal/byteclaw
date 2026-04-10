import type { ModelProviderConfig } from "@openclaw/plugin-sdk/provider-model-shared";
import { XAI_BASE_URL, buildXaiCatalogModels } from "./model-definitions.js";

export function buildXaiProvider(
  api: ModelProviderConfig["api"] = "openai-responses",
): ModelProviderConfig {
  return {
    api,
    baseUrl: XAI_BASE_URL,
    models: buildXaiCatalogModels(),
  };
}
