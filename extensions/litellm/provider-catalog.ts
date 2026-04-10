import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LITELLM_BASE_URL, buildLitellmModelDefinition } from "./onboard.js";

export function buildLitellmProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: LITELLM_BASE_URL,
    models: [buildLitellmModelDefinition()],
  };
}
