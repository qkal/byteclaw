import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { SYNTHETIC_DEFAULT_MODEL_REF, applySyntheticConfig } from "./onboard.js";
import { buildSyntheticProvider } from "./provider-catalog.js";

const PROVIDER_ID = "synthetic";

export default defineSingleProviderPluginEntry({
  description: "Bundled Synthetic provider plugin",
  id: PROVIDER_ID,
  name: "Synthetic Provider",
  provider: {
    auth: [
      {
        applyConfig: (cfg) => applySyntheticConfig(cfg),
        defaultModel: SYNTHETIC_DEFAULT_MODEL_REF,
        envVar: "SYNTHETIC_API_KEY",
        flagName: "--synthetic-api-key",
        hint: "Anthropic-compatible (multi-model)",
        label: "Synthetic API key",
        methodId: "api-key",
        optionKey: "syntheticApiKey",
        promptMessage: "Enter Synthetic API key",
      },
    ],
    catalog: {
      buildProvider: buildSyntheticProvider,
    },
    docsPath: "/providers/synthetic",
    label: "Synthetic",
  },
});
