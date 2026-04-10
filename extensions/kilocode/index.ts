import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { KILOCODE_DEFAULT_MODEL_REF, applyKilocodeConfig } from "./onboard.js";
import { buildKilocodeProviderWithDiscovery } from "./provider-catalog.js";

const PROVIDER_ID = "kilocode";
const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});
const KILOCODE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("kilocode-thinking");

export default defineSingleProviderPluginEntry({
  description: "Bundled Kilo Gateway provider plugin",
  id: PROVIDER_ID,
  name: "Kilo Gateway Provider",
  provider: {
    label: "Kilo Gateway",
    docsPath: "/providers/kilocode",
    auth: [
      {
        applyConfig: (cfg) => applyKilocodeConfig(cfg),
        defaultModel: KILOCODE_DEFAULT_MODEL_REF,
        envVar: "KILOCODE_API_KEY",
        flagName: "--kilocode-api-key",
        hint: "API key (OpenRouter-compatible)",
        label: "Kilo Gateway API key",
        methodId: "api-key",
        optionKey: "kilocodeApiKey",
        promptMessage: "Enter Kilo Gateway API key",
      },
    ],
    catalog: {
      buildProvider: buildKilocodeProviderWithDiscovery,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
    ...KILOCODE_THINKING_STREAM_HOOKS,
    isCacheTtlEligible: (ctx) => ctx.modelId.startsWith("anthropic/"),
  },
});
