import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { HUGGINGFACE_DEFAULT_MODEL_REF, applyHuggingfaceConfig } from "./onboard.js";
import { buildHuggingfaceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "huggingface";

interface HuggingFacePluginConfig {
  discovery?: {
    enabled?: boolean;
  };
}

export default defineSingleProviderPluginEntry({
  description: "Bundled Hugging Face provider plugin",
  id: PROVIDER_ID,
  name: "Hugging Face Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applyHuggingfaceConfig(cfg),
        defaultModel: HUGGINGFACE_DEFAULT_MODEL_REF,
        envVar: "HUGGINGFACE_HUB_TOKEN",
        flagName: "--huggingface-api-key",
        hint: "Inference API (HF token)",
        label: "Hugging Face API key",
        methodId: "api-key",
        optionKey: "huggingfaceApiKey",
        promptMessage: "Enter Hugging Face API key",
      },
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const pluginEntry = ctx.config?.plugins?.entries?.[PROVIDER_ID];
        const pluginConfig =
          pluginEntry && typeof pluginEntry === "object" && pluginEntry.config
            ? (pluginEntry.config as HuggingFacePluginConfig)
            : undefined;
        const discoveryEnabled =
          pluginConfig?.discovery?.enabled ?? ctx.config?.models?.huggingfaceDiscovery?.enabled;
        if (discoveryEnabled === false) {
          return null;
        }
        const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        return {
          provider: {
            ...(await buildHuggingfaceProvider(discoveryApiKey)),
            apiKey,
          },
        };
      },
    },
    docsPath: "/providers/huggingface",
    envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
    label: "Hugging Face",
  },
});
