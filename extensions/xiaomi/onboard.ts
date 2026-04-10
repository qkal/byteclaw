import {
  type OpenClawConfig,
  createDefaultModelsPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import { XIAOMI_DEFAULT_MODEL_ID, buildXiaomiProvider } from "./provider-catalog.js";

export const XIAOMI_DEFAULT_MODEL_REF = `xiaomi/${XIAOMI_DEFAULT_MODEL_ID}`;

const xiaomiPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: XIAOMI_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => {
    const defaultProvider = buildXiaomiProvider();
    return {
      aliases: [{ alias: "Xiaomi", modelRef: XIAOMI_DEFAULT_MODEL_REF }],
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      defaultModelId: XIAOMI_DEFAULT_MODEL_ID,
      defaultModels: defaultProvider.models ?? [],
      providerId: "xiaomi",
    };
  },
});

export function applyXiaomiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return xiaomiPresetAppliers.applyProviderConfig(cfg);
}

export function applyXiaomiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return xiaomiPresetAppliers.applyConfig(cfg);
}
