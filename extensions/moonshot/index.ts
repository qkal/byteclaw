import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { applyMoonshotNativeStreamingUsageCompat } from "./api.js";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  MOONSHOT_DEFAULT_MODEL_REF,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
} from "./onboard.js";
import { buildMoonshotProvider } from "./provider-catalog.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const PROVIDER_ID = "moonshot";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});
const MOONSHOT_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("moonshot-thinking");

export default defineSingleProviderPluginEntry({
  description: "Bundled Moonshot provider plugin",
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  provider: {
    applyNativeStreamingUsageCompat: ({ providerConfig }) =>
      applyMoonshotNativeStreamingUsageCompat(providerConfig),
    auth: [
      {
        applyConfig: (cfg) => applyMoonshotConfig(cfg),
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        envVar: "MOONSHOT_API_KEY",
        flagName: "--moonshot-api-key",
        hint: "Kimi K2.5 + Kimi",
        label: "Kimi API key (.ai)",
        methodId: "api-key",
        optionKey: "moonshotApiKey",
        promptMessage: "Enter Moonshot API key",
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.5)",
        },
      },
      {
        applyConfig: (cfg) => applyMoonshotConfigCn(cfg),
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        envVar: "MOONSHOT_API_KEY",
        flagName: "--moonshot-api-key",
        hint: "Kimi K2.5 + Kimi",
        label: "Kimi API key (.cn)",
        methodId: "api-key-cn",
        optionKey: "moonshotApiKey",
        promptMessage: "Enter Moonshot API key (.cn)",
        wizard: {
          groupLabel: "Moonshot AI (Kimi K2.5)",
        },
      },
    ],
    catalog: {
      allowExplicitBaseUrl: true,
      buildProvider: buildMoonshotProvider,
    },
    docsPath: "/providers/moonshot",
    label: "Moonshot",
    ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    ...MOONSHOT_THINKING_STREAM_HOOKS,
  },
  register(api) {
    api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});
