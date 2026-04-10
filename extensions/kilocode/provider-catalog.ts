import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  KILOCODE_BASE_URL as LOCAL_KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_CONTEXT_WINDOW as LOCAL_KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST as LOCAL_KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MAX_TOKENS as LOCAL_KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_MODEL_CATALOG as LOCAL_KILOCODE_MODEL_CATALOG,
  discoverKilocodeModels,
} from "./provider-models.js";

export function buildKilocodeProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: LOCAL_KILOCODE_BASE_URL,
    models: LOCAL_KILOCODE_MODEL_CATALOG.map((model) => ({
      contextWindow: model.contextWindow ?? LOCAL_KILOCODE_DEFAULT_CONTEXT_WINDOW,
      cost: LOCAL_KILOCODE_DEFAULT_COST,
      id: model.id,
      input: model.input,
      maxTokens: model.maxTokens ?? LOCAL_KILOCODE_DEFAULT_MAX_TOKENS,
      name: model.name,
      reasoning: model.reasoning,
    })),
  };
}

export async function buildKilocodeProviderWithDiscovery(): Promise<ModelProviderConfig> {
  const models = await discoverKilocodeModels();
  return {
    api: "openai-completions",
    baseUrl: LOCAL_KILOCODE_BASE_URL,
    models,
  };
}
