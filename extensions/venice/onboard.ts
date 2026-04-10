import {
  type OpenClawConfig,
  createModelCatalogPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  VENICE_BASE_URL,
  VENICE_DEFAULT_MODEL_REF,
  VENICE_MODEL_CATALOG,
  buildVeniceModelDefinition,
} from "./api.js";

export { VENICE_DEFAULT_MODEL_REF };

const venicePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: VENICE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    aliases: [{ alias: "Kimi K2.5", modelRef: VENICE_DEFAULT_MODEL_REF }],
    api: "openai-completions",
    baseUrl: VENICE_BASE_URL,
    catalogModels: VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition),
    providerId: "venice",
  }),
});

export function applyVeniceProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return venicePresetAppliers.applyProviderConfig(cfg);
}

export function applyVeniceConfig(cfg: OpenClawConfig): OpenClawConfig {
  return venicePresetAppliers.applyConfig(cfg);
}
