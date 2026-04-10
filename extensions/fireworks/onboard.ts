import {
  type OpenClawConfig,
  createDefaultModelsPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  FIREWORKS_DEFAULT_MODEL_ID,
  buildFireworksCatalogModels,
  buildFireworksProvider,
} from "./provider-catalog.js";

export const FIREWORKS_DEFAULT_MODEL_REF = `fireworks/${FIREWORKS_DEFAULT_MODEL_ID}`;

const fireworksPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: FIREWORKS_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => {
    const defaultProvider = buildFireworksProvider();
    return {
      aliases: [{ alias: "Kimi K2.5 Turbo", modelRef: FIREWORKS_DEFAULT_MODEL_REF }],
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      defaultModelId: FIREWORKS_DEFAULT_MODEL_ID,
      defaultModels: buildFireworksCatalogModels(),
      providerId: "fireworks",
    };
  },
});

export function applyFireworksProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return fireworksPresetAppliers.applyProviderConfig(cfg);
}

export function applyFireworksConfig(cfg: OpenClawConfig): OpenClawConfig {
  return fireworksPresetAppliers.applyConfig(cfg);
}
