import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  SYNTHETIC_BASE_URL,
  SYNTHETIC_MODEL_CATALOG,
  buildSyntheticModelDefinition,
} from "./models.js";

export function buildSyntheticProvider(): ModelProviderConfig {
  return {
    api: "anthropic-messages",
    baseUrl: SYNTHETIC_BASE_URL,
    models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
  };
}
