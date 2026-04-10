import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  BYTEPLUS_BASE_URL,
  BYTEPLUS_CODING_BASE_URL,
  BYTEPLUS_CODING_MODEL_CATALOG,
  BYTEPLUS_MODEL_CATALOG,
  buildBytePlusModelDefinition,
} from "./models.js";

export function buildBytePlusProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: BYTEPLUS_BASE_URL,
    models: BYTEPLUS_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  };
}

export function buildBytePlusCodingProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: BYTEPLUS_CODING_BASE_URL,
    models: BYTEPLUS_CODING_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  };
}
