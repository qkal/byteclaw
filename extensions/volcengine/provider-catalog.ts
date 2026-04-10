import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DOUBAO_BASE_URL,
  DOUBAO_CODING_BASE_URL,
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
  buildDoubaoModelDefinition,
} from "./models.js";

export function buildDoubaoProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: DOUBAO_BASE_URL,
    models: DOUBAO_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  };
}

export function buildDoubaoCodingProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: DOUBAO_CODING_BASE_URL,
    models: DOUBAO_CODING_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  };
}
