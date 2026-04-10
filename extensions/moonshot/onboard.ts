import {
  type OpenClawConfig,
  createDefaultModelPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  buildMoonshotProvider,
} from "./provider-catalog.js";
export const MOONSHOT_DEFAULT_MODEL_REF = `moonshot/${MOONSHOT_DEFAULT_MODEL_ID}`;

const moonshotPresetAppliers = createDefaultModelPresetAppliers<[string]>({
  primaryModelRef: MOONSHOT_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig, baseUrl: string) => {
    const defaultModel = buildMoonshotProvider().models[0];
    if (!defaultModel) {
      return null;
    }

    return {
      aliases: [{ alias: "Kimi", modelRef: MOONSHOT_DEFAULT_MODEL_REF }],
      api: "openai-completions",
      baseUrl,
      defaultModel,
      defaultModelId: MOONSHOT_DEFAULT_MODEL_ID,
      providerId: "moonshot",
    };
  },
});

export function applyMoonshotProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return moonshotPresetAppliers.applyProviderConfig(cfg, MOONSHOT_BASE_URL);
}

export function applyMoonshotProviderConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return moonshotPresetAppliers.applyProviderConfig(cfg, MOONSHOT_CN_BASE_URL);
}

export function applyMoonshotConfig(cfg: OpenClawConfig): OpenClawConfig {
  return moonshotPresetAppliers.applyConfig(cfg, MOONSHOT_BASE_URL);
}

export function applyMoonshotConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return moonshotPresetAppliers.applyConfig(cfg, MOONSHOT_CN_BASE_URL);
}
