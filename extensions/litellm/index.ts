import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { LITELLM_DEFAULT_MODEL_REF, applyLitellmConfig } from "./onboard.js";
import { buildLitellmProvider } from "./provider-catalog.js";

const PROVIDER_ID = "litellm";

export default defineSingleProviderPluginEntry({
  description: "Bundled LiteLLM provider plugin",
  id: PROVIDER_ID,
  name: "LiteLLM Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applyLitellmConfig(cfg),
        defaultModel: LITELLM_DEFAULT_MODEL_REF,
        envVar: "LITELLM_API_KEY",
        flagName: "--litellm-api-key",
        hint: "Unified gateway for 100+ LLM providers",
        label: "LiteLLM API key",
        methodId: "api-key",
        noteMessage: [
          "LiteLLM provides a unified API to 100+ LLM providers.",
          "Get your API key from your LiteLLM proxy or https://litellm.ai",
          "Default proxy runs on http://localhost:4000",
        ].join("\n"),
        noteTitle: "LiteLLM",
        optionKey: "litellmApiKey",
        promptMessage: "Enter LiteLLM API key",
        wizard: {
          groupHint: "Unified LLM gateway (100+ providers)",
        },
      },
    ],
    catalog: {
      allowExplicitBaseUrl: true,
      buildProvider: buildLitellmProvider,
    },
    docsPath: "/providers/litellm",
    label: "LiteLLM",
  },
});
