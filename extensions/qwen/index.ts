import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyQwenNativeStreamingUsageCompat } from "./api.js";
import { buildQwenMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { QWEN_36_PLUS_MODEL_ID, QWEN_BASE_URL, isQwenCodingPlanBaseUrl } from "./models.js";
import {
  QWEN_DEFAULT_MODEL_REF,
  applyQwenConfig,
  applyQwenConfigCn,
  applyQwenStandardConfig,
  applyQwenStandardConfigCn,
} from "./onboard.js";
import { buildQwenProvider } from "./provider-catalog.js";
import { buildQwenVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "qwen";
const LEGACY_PROVIDER_ID = "modelstudio";

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase();
}

function resolveConfiguredQwenBaseUrl(
  config: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
): string | undefined {
  const providers = config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    const normalized = normalizeProviderId(providerId);
    if (normalized !== PROVIDER_ID && normalized !== LEGACY_PROVIDER_ID) {
      continue;
    }
    const baseUrl = provider?.baseUrl?.trim();
    if (baseUrl) {
      return baseUrl;
    }
  }
  return undefined;
}

function isQwen36PlusUnsupportedForConfig(params: {
  config: Parameters<typeof resolveConfiguredQwenBaseUrl>[0];
  baseUrl?: string;
}): boolean {
  return isQwenCodingPlanBaseUrl(params.baseUrl ?? resolveConfiguredQwenBaseUrl(params.config));
}

export default defineSingleProviderPluginEntry({
  description: "Bundled Qwen Cloud provider plugin",
  id: PROVIDER_ID,
  name: "Qwen Provider",
  provider: {
    aliases: ["modelstudio", "qwencloud"],
    applyNativeStreamingUsageCompat: ({ providerConfig }) =>
      applyQwenNativeStreamingUsageCompat(providerConfig),
    auth: [
      {
        applyConfig: (cfg) => applyQwenStandardConfigCn(cfg),
        defaultModel: QWEN_DEFAULT_MODEL_REF,
        envVar: "QWEN_API_KEY",
        flagName: "--modelstudio-standard-api-key-cn",
        hint: "Endpoint: dashscope.aliyuncs.com",
        label: "Standard API Key for China (pay-as-you-go)",
        methodId: "standard-api-key-cn",
        noteMessage: [
          "Manage API keys: https://home.qwencloud.com/api-keys",
          "Docs: https://docs.qwencloud.com/",
          "Endpoint: dashscope.aliyuncs.com/compatible-mode/v1",
          "Models: qwen3.6-plus, qwen3.5-plus, qwen3-coder-plus, etc.",
        ].join("\n"),
        noteTitle: "Qwen Cloud Standard (China)",
        optionKey: "modelstudioStandardApiKeyCn",
        promptMessage: "Enter Qwen Cloud API key (China standard endpoint)",
        wizard: {
          choiceHint: "Endpoint: dashscope.aliyuncs.com",
          groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
          groupLabel: "Qwen Cloud",
        },
      },
      {
        applyConfig: (cfg) => applyQwenStandardConfig(cfg),
        defaultModel: QWEN_DEFAULT_MODEL_REF,
        envVar: "QWEN_API_KEY",
        flagName: "--modelstudio-standard-api-key",
        hint: "Endpoint: dashscope-intl.aliyuncs.com",
        label: "Standard API Key for Global/Intl (pay-as-you-go)",
        methodId: "standard-api-key",
        noteMessage: [
          "Manage API keys: https://home.qwencloud.com/api-keys",
          "Docs: https://docs.qwencloud.com/",
          "Endpoint: dashscope-intl.aliyuncs.com/compatible-mode/v1",
          "Models: qwen3.6-plus, qwen3.5-plus, qwen3-coder-plus, etc.",
        ].join("\n"),
        noteTitle: "Qwen Cloud Standard (Global/Intl)",
        optionKey: "modelstudioStandardApiKey",
        promptMessage: "Enter Qwen Cloud API key (Global/Intl standard endpoint)",
        wizard: {
          choiceHint: "Endpoint: dashscope-intl.aliyuncs.com",
          groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
          groupLabel: "Qwen Cloud",
        },
      },
      {
        applyConfig: (cfg) => applyQwenConfigCn(cfg),
        defaultModel: QWEN_DEFAULT_MODEL_REF,
        envVar: "QWEN_API_KEY",
        flagName: "--modelstudio-api-key-cn",
        hint: "Endpoint: coding.dashscope.aliyuncs.com",
        label: "Coding Plan API Key for China (subscription)",
        methodId: "api-key-cn",
        noteMessage: [
          "Manage API keys: https://home.qwencloud.com/api-keys",
          "Docs: https://docs.qwencloud.com/",
          "Endpoint: coding.dashscope.aliyuncs.com",
          "Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc.",
        ].join("\n"),
        noteTitle: "Qwen Cloud Coding Plan (China)",
        optionKey: "modelstudioApiKeyCn",
        promptMessage: "Enter Qwen Cloud Coding Plan API key (China)",
        wizard: {
          choiceHint: "Endpoint: coding.dashscope.aliyuncs.com",
          groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
          groupLabel: "Qwen Cloud",
        },
      },
      {
        applyConfig: (cfg) => applyQwenConfig(cfg),
        defaultModel: QWEN_DEFAULT_MODEL_REF,
        envVar: "QWEN_API_KEY",
        flagName: "--modelstudio-api-key",
        hint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
        label: "Coding Plan API Key for Global/Intl (subscription)",
        methodId: "api-key",
        noteMessage: [
          "Manage API keys: https://home.qwencloud.com/api-keys",
          "Docs: https://docs.qwencloud.com/",
          "Endpoint: coding-intl.dashscope.aliyuncs.com",
          "Models: qwen3.5-plus, glm-5, kimi-k2.5, MiniMax-M2.5, etc.",
        ].join("\n"),
        noteTitle: "Qwen Cloud Coding Plan (Global/Intl)",
        optionKey: "modelstudioApiKey",
        promptMessage: "Enter Qwen Cloud Coding Plan API key (Global/Intl)",
        wizard: {
          choiceHint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
          groupHint: "Standard / Coding Plan (CN / Global) + multimodal roadmap",
          groupLabel: "Qwen Cloud",
        },
      },
    ],
    catalog: {
      run: async (ctx) => {
        const { apiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        const baseUrl = resolveConfiguredQwenBaseUrl(ctx.config) ?? QWEN_BASE_URL;
        return {
          provider: {
            ...buildQwenProvider({ baseUrl }),
            apiKey,
          },
        };
      },
    },
    docsPath: "/providers/qwen",
    label: "Qwen Cloud",
    normalizeConfig: ({ providerConfig }) => {
      if (!isQwenCodingPlanBaseUrl(providerConfig.baseUrl)) {
        return undefined;
      }
      const models = providerConfig.models?.filter((model) => model.id !== QWEN_36_PLUS_MODEL_ID);
      return models && models.length !== providerConfig.models?.length
        ? { ...providerConfig, models }
        : undefined;
    },
    suppressBuiltInModel: (ctx) => {
      const provider = normalizeProviderId(ctx.provider);
      if (
        (provider !== PROVIDER_ID && provider !== LEGACY_PROVIDER_ID) ||
        ctx.modelId !== QWEN_36_PLUS_MODEL_ID ||
        !isQwen36PlusUnsupportedForConfig({ baseUrl: ctx.baseUrl, config: ctx.config })
      ) {
        return undefined;
      }
      return {
        errorMessage:
          "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.",
        suppress: true,
      };
    },
  },
  register(api) {
    api.registerMediaUnderstandingProvider(buildQwenMediaUnderstandingProvider());
    api.registerVideoGenerationProvider(buildQwenVideoGenerationProvider());
  },
});
