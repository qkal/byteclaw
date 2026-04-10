import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
  buildTogetherModelDefinition,
} from "./models.js";

export function buildTogetherProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: TOGETHER_BASE_URL,
    models: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
  };
}
