import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { OPENCODE_GO_DEFAULT_MODEL_REF, applyOpencodeGoConfig } from "./api.js";

const PROVIDER_ID = "opencode-go";
const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});

export default definePluginEntry({
  description: "Bundled OpenCode Go provider plugin",
  id: PROVIDER_ID,
  name: "OpenCode Go Provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenCode Go",
      docsPath: "/providers/models",
      envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          applyConfig: (cfg) => applyOpencodeGoConfig(cfg),
          defaultModel: OPENCODE_GO_DEFAULT_MODEL_REF,
          envVar: "OPENCODE_API_KEY",
          expectedProviders: ["opencode", "opencode-go"],
          flagName: "--opencode-go-api-key",
          hint: "Shared API key for Zen + Go catalogs",
          label: "OpenCode Go catalog",
          methodId: "api-key",
          noteMessage: [
            "OpenCode uses one API key across the Zen and Go catalogs.",
            "Go focuses on Kimi, GLM, and MiniMax coding models.",
            "Get your API key at: https://opencode.ai/auth",
          ].join("\n"),
          noteTitle: "OpenCode",
          optionKey: "opencodeGoApiKey",
          profileIds: ["opencode:default", "opencode-go:default"],
          promptMessage: "Enter OpenCode API key",
          providerId: PROVIDER_ID,
          wizard: {
            choiceId: "opencode-go",
            choiceLabel: "OpenCode Go catalog",
            groupHint: "Shared API key for Zen + Go catalogs",
            groupId: "opencode",
            groupLabel: "OpenCode",
          },
        }),
      ],
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      isModernModelRef: () => true,
    });
  },
});
