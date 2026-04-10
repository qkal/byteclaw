import {
  type OpenClawConfig,
  createModelCatalogPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import { ARCEE_BASE_URL } from "./models.js";
import {
  OPENROUTER_BASE_URL,
  buildArceeCatalogModels,
  buildArceeOpenRouterCatalogModels,
} from "./provider-catalog.js";

export const ARCEE_DEFAULT_MODEL_REF = "arcee/trinity-large-thinking";
export const ARCEE_OPENROUTER_DEFAULT_MODEL_REF = "arcee/trinity-large-thinking";

const arceePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: ARCEE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    aliases: [{ alias: "Arcee AI", modelRef: ARCEE_DEFAULT_MODEL_REF }],
    api: "openai-completions",
    baseUrl: ARCEE_BASE_URL,
    catalogModels: buildArceeCatalogModels(),
    providerId: "arcee",
  }),
});

const arceeOpenRouterPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    aliases: [{ alias: "Arcee AI (OpenRouter)", modelRef: ARCEE_OPENROUTER_DEFAULT_MODEL_REF }],
    api: "openai-completions",
    baseUrl: OPENROUTER_BASE_URL,
    catalogModels: buildArceeOpenRouterCatalogModels(),
    providerId: "arcee",
  }),
});

export function applyArceeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return arceePresetAppliers.applyProviderConfig(cfg);
}

export function applyArceeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return arceePresetAppliers.applyConfig(cfg);
}

export function applyArceeOpenRouterConfig(cfg: OpenClawConfig): OpenClawConfig {
  return arceeOpenRouterPresetAppliers.applyConfig(cfg);
}
