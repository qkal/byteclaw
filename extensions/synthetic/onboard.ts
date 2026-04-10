import {
  type OpenClawConfig,
  createModelCatalogPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  SYNTHETIC_BASE_URL,
  SYNTHETIC_DEFAULT_MODEL_REF,
  SYNTHETIC_MODEL_CATALOG,
  buildSyntheticModelDefinition,
} from "./models.js";

export { SYNTHETIC_DEFAULT_MODEL_REF };

const syntheticPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: SYNTHETIC_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    aliases: [{ alias: "MiniMax M2.5", modelRef: SYNTHETIC_DEFAULT_MODEL_REF }],
    api: "anthropic-messages",
    baseUrl: SYNTHETIC_BASE_URL,
    catalogModels: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
    providerId: "synthetic",
  }),
});

export function applySyntheticProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return syntheticPresetAppliers.applyProviderConfig(cfg);
}

export function applySyntheticConfig(cfg: OpenClawConfig): OpenClawConfig {
  return syntheticPresetAppliers.applyConfig(cfg);
}
