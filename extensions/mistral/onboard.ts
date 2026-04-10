import {
  type OpenClawConfig,
  createDefaultModelPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
  buildMistralModelDefinition,
} from "./model-definitions.js";

export const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;

const mistralPresetAppliers = createDefaultModelPresetAppliers({
  primaryModelRef: MISTRAL_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    aliases: [{ alias: "Mistral", modelRef: MISTRAL_DEFAULT_MODEL_REF }],
    api: "openai-completions",
    baseUrl: MISTRAL_BASE_URL,
    defaultModel: buildMistralModelDefinition(),
    defaultModelId: MISTRAL_DEFAULT_MODEL_ID,
    providerId: "mistral",
  }),
});

export function applyMistralProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return mistralPresetAppliers.applyProviderConfig(cfg);
}

export function applyMistralConfig(cfg: OpenClawConfig): OpenClawConfig {
  return mistralPresetAppliers.applyConfig(cfg);
}
