import {
  type OpenClawConfig,
  createModelCatalogPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
  buildTogetherModelDefinition,
} from "./models.js";

export const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";

const togetherPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: TOGETHER_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    aliases: [{ alias: "Together AI", modelRef: TOGETHER_DEFAULT_MODEL_REF }],
    api: "openai-completions",
    baseUrl: TOGETHER_BASE_URL,
    catalogModels: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
    providerId: "together",
  }),
});

export function applyTogetherProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return togetherPresetAppliers.applyProviderConfig(cfg);
}

export function applyTogetherConfig(cfg: OpenClawConfig): OpenClawConfig {
  return togetherPresetAppliers.applyConfig(cfg);
}
