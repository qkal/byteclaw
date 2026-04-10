import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyMistralModelCompat } from "./api.js";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { MISTRAL_DEFAULT_MODEL_REF, applyMistralConfig } from "./onboard.js";
import { buildMistralProvider } from "./provider-catalog.js";
import { contributeMistralResolvedModelCompat } from "./provider-compat.js";

const PROVIDER_ID = "mistral";
export function buildMistralReplayPolicy() {
  return {
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict9" as const,
  };
}

export default defineSingleProviderPluginEntry({
  description: "Bundled Mistral provider plugin",
  id: PROVIDER_ID,
  name: "Mistral Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applyMistralConfig(cfg),
        defaultModel: MISTRAL_DEFAULT_MODEL_REF,
        envVar: "MISTRAL_API_KEY",
        flagName: "--mistral-api-key",
        hint: "API key",
        label: "Mistral API key",
        methodId: "api-key",
        optionKey: "mistralApiKey",
        promptMessage: "Enter Mistral API key",
        wizard: {
          groupLabel: "Mistral AI",
        },
      },
    ],
    buildReplayPolicy: () => buildMistralReplayPolicy(),
    catalog: {
      allowExplicitBaseUrl: true,
      buildProvider: buildMistralProvider,
    },
    contributeResolvedModelCompat: ({ modelId, model }) =>
      contributeMistralResolvedModelCompat({ model, modelId }),
    docsPath: "/providers/models",
    label: "Mistral",
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bmistral\b.*(?:input.*too long|token limit.*exceeded)/i.test(errorMessage),
    normalizeResolvedModel: ({ model }) => applyMistralModelCompat(model),
  },
  register(api) {
    api.registerMediaUnderstandingProvider(mistralMediaUnderstandingProvider);
  },
});
