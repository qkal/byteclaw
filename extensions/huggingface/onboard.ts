import {
  type OpenClawConfig,
  createModelCatalogPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
  buildHuggingfaceModelDefinition,
} from "./models.js";

export const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";

const huggingfacePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: HUGGINGFACE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    aliases: [{ alias: "Hugging Face", modelRef: HUGGINGFACE_DEFAULT_MODEL_REF }],
    api: "openai-completions",
    baseUrl: HUGGINGFACE_BASE_URL,
    catalogModels: HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition),
    providerId: "huggingface",
  }),
});

export function applyHuggingfaceProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return huggingfacePresetAppliers.applyProviderConfig(cfg);
}

export function applyHuggingfaceConfig(cfg: OpenClawConfig): OpenClawConfig {
  return huggingfacePresetAppliers.applyConfig(cfg);
}
