import {
  type OpenClawConfig,
  createDefaultModelPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  KIMI_CODING_BASE_URL,
  KIMI_CODING_DEFAULT_MODEL_ID,
  buildKimiCodingProvider,
} from "./provider-catalog.js";

export const KIMI_MODEL_REF = `kimi/${KIMI_CODING_DEFAULT_MODEL_ID}`;
export const KIMI_CODING_MODEL_REF = KIMI_MODEL_REF;

function resolveKimiCodingDefaultModel() {
  return buildKimiCodingProvider().models[0];
}

const kimiCodingPresetAppliers = createDefaultModelPresetAppliers({
  primaryModelRef: KIMI_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => {
    const defaultModel = resolveKimiCodingDefaultModel();
    if (!defaultModel) {
      return null;
    }
    return {
      aliases: [{ alias: "Kimi", modelRef: KIMI_MODEL_REF }],
      api: "anthropic-messages",
      baseUrl: KIMI_CODING_BASE_URL,
      defaultModel,
      defaultModelId: KIMI_CODING_DEFAULT_MODEL_ID,
      providerId: "kimi",
    };
  },
});

export function applyKimiCodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return kimiCodingPresetAppliers.applyProviderConfig(cfg);
}

export function applyKimiCodeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return kimiCodingPresetAppliers.applyConfig(cfg);
}
