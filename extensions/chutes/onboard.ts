import {
  type OpenClawConfig,
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalogPreset,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  CHUTES_BASE_URL,
  CHUTES_DEFAULT_MODEL_REF,
  CHUTES_MODEL_CATALOG,
  buildChutesModelDefinition,
} from "./models.js";

export { CHUTES_DEFAULT_MODEL_REF };

/**
 * Apply Chutes provider configuration without changing the default model.
 * Registers all catalog models and sets provider aliases (chutes-fast, etc.).
 */
export function applyChutesProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyProviderConfigWithModelCatalogPreset(cfg, {
    aliases: [
      ...CHUTES_MODEL_CATALOG.map((model) => `chutes/${model.id}`),
      { alias: "chutes/zai-org/GLM-4.7-FP8", modelRef: "chutes-fast" },
      {
        alias: "chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506",
        modelRef: "chutes-vision",
      },
      { alias: "chutes/deepseek-ai/DeepSeek-V3.2-TEE", modelRef: "chutes-pro" },
    ],
    api: "openai-completions",
    baseUrl: CHUTES_BASE_URL,
    catalogModels: CHUTES_MODEL_CATALOG.map(buildChutesModelDefinition),
    providerId: "chutes",
  });
}

/**
 * Apply Chutes provider configuration AND set Chutes as the default model.
 */
export function applyChutesConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyChutesProviderConfig(cfg);
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        imageModel: {
          fallbacks: ["chutes/chutesai/Mistral-Small-3.1-24B-Instruct-2503"],
          primary: "chutes/chutesai/Mistral-Small-3.2-24B-Instruct-2506",
        },
        model: {
          fallbacks: ["chutes/deepseek-ai/DeepSeek-V3.2-TEE", "chutes/Qwen/Qwen3-32B"],
          primary: CHUTES_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}

export function applyChutesApiKeyConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(applyChutesProviderConfig(cfg), CHUTES_DEFAULT_MODEL_REF);
}
