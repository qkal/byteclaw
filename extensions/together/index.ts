import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { TOGETHER_DEFAULT_MODEL_REF, applyTogetherConfig } from "./onboard.js";
import { buildTogetherProvider } from "./provider-catalog.js";
import { buildTogetherVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "together";

export default defineSingleProviderPluginEntry({
  description: "Bundled Together provider plugin",
  id: PROVIDER_ID,
  name: "Together Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applyTogetherConfig(cfg),
        defaultModel: TOGETHER_DEFAULT_MODEL_REF,
        envVar: "TOGETHER_API_KEY",
        flagName: "--together-api-key",
        hint: "API key",
        label: "Together AI API key",
        methodId: "api-key",
        optionKey: "togetherApiKey",
        promptMessage: "Enter Together AI API key",
        wizard: {
          groupLabel: "Together AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildTogetherProvider,
    },
    classifyFailoverReason: ({ errorMessage }) =>
      /\bconcurrency limit\b.*\b(?:breached|reached)\b/i.test(errorMessage)
        ? "rate_limit"
        : undefined,
    docsPath: "/providers/together",
    label: "Together",
  },
  register(api) {
    api.registerVideoGenerationProvider(buildTogetherVideoGenerationProvider());
  },
});
