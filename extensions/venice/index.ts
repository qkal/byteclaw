import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyXaiModelCompat } from "openclaw/plugin-sdk/provider-tools";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { VENICE_DEFAULT_MODEL_REF, applyVeniceConfig } from "./onboard.js";
import { buildVeniceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "venice";

function isXaiBackedVeniceModel(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("grok");
}

export default defineSingleProviderPluginEntry({
  description: "Bundled Venice provider plugin",
  id: PROVIDER_ID,
  name: "Venice Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applyVeniceConfig(cfg),
        defaultModel: VENICE_DEFAULT_MODEL_REF,
        envVar: "VENICE_API_KEY",
        flagName: "--venice-api-key",
        hint: "Privacy-focused (uncensored models)",
        label: "Venice AI API key",
        methodId: "api-key",
        noteMessage: [
          "Venice AI provides privacy-focused inference with uncensored models.",
          "Get your API key at: https://venice.ai/settings/api",
          "Supports 'private' (fully private) and 'anonymized' (proxy) modes.",
        ].join("\n"),
        noteTitle: "Venice AI",
        optionKey: "veniceApiKey",
        promptMessage: "Enter Venice AI API key",
        wizard: {
          groupLabel: "Venice AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildVeniceProvider,
    },
    docsPath: "/providers/venice",
    label: "Venice",
    normalizeResolvedModel: ({ modelId, model }) =>
      isXaiBackedVeniceModel(modelId) ? applyXaiModelCompat(model) : undefined,
  },
});
