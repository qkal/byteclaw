import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { DEEPSEEK_DEFAULT_MODEL_REF, applyDeepSeekConfig } from "./onboard.js";
import { buildDeepSeekProvider } from "./provider-catalog.js";

const PROVIDER_ID = "deepseek";

export default defineSingleProviderPluginEntry({
  description: "Bundled DeepSeek provider plugin",
  id: PROVIDER_ID,
  name: "DeepSeek Provider",
  provider: {
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    auth: [
      {
        applyConfig: (cfg) => applyDeepSeekConfig(cfg),
        defaultModel: DEEPSEEK_DEFAULT_MODEL_REF,
        envVar: "DEEPSEEK_API_KEY",
        flagName: "--deepseek-api-key",
        hint: "API key",
        label: "DeepSeek API key",
        methodId: "api-key",
        optionKey: "deepseekApiKey",
        promptMessage: "Enter DeepSeek API key",
        wizard: {
          choiceId: "deepseek-api-key",
          choiceLabel: "DeepSeek API key",
          groupHint: "API key",
          groupId: "deepseek",
          groupLabel: "DeepSeek",
        },
      },
    ],
    catalog: {
      buildProvider: buildDeepSeekProvider,
    },
    docsPath: "/providers/deepseek",
    label: "DeepSeek",
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bdeepseek\b.*(?:input.*too long|context.*exceed)/i.test(errorMessage),
  },
});
