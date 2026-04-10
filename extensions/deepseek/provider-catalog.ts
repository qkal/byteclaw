import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL_CATALOG,
  buildDeepSeekModelDefinition,
} from "./models.js";

export function buildDeepSeekProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: DEEPSEEK_BASE_URL,
    models: DEEPSEEK_MODEL_CATALOG.map(buildDeepSeekModelDefinition),
  };
}
