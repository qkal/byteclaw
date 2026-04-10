import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { PROVIDER_LABELS } from "openclaw/plugin-sdk/provider-usage";
import { XIAOMI_DEFAULT_MODEL_REF, applyXiaomiConfig } from "./onboard.js";
import { buildXiaomiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "xiaomi";

export default defineSingleProviderPluginEntry({
  description: "Bundled Xiaomi provider plugin",
  id: PROVIDER_ID,
  name: "Xiaomi Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applyXiaomiConfig(cfg),
        defaultModel: XIAOMI_DEFAULT_MODEL_REF,
        envVar: "XIAOMI_API_KEY",
        flagName: "--xiaomi-api-key",
        hint: "API key",
        label: "Xiaomi API key",
        methodId: "api-key",
        optionKey: "xiaomiApiKey",
        promptMessage: "Enter Xiaomi API key",
      },
    ],
    catalog: {
      buildProvider: buildXiaomiProvider,
    },
    docsPath: "/providers/xiaomi",
    fetchUsageSnapshot: async () => ({
      displayName: PROVIDER_LABELS.xiaomi,
      provider: "xiaomi",
      windows: [],
    }),
    label: "Xiaomi",
    resolveUsageAuth: async (ctx) => {
      const apiKey = ctx.resolveApiKeyFromConfigAndStore({
        envDirect: [ctx.env.XIAOMI_API_KEY],
      });
      return apiKey ? { token: apiKey } : null;
    },
  },
});
