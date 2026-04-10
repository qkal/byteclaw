import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildProviderReplayFamilyHooks,
  matchesExactOrPrefix,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { OPENCODE_ZEN_DEFAULT_MODEL, applyOpencodeZenConfig } from "./api.js";

const PROVIDER_ID = "opencode";
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"] as const;
const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});

function isModernOpencodeModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  if (lower.endsWith("-free") || lower === "alpha-glm-4.7") {
    return false;
  }
  return !matchesExactOrPrefix(lower, MINIMAX_MODERN_MODEL_MATCHERS);
}

export default definePluginEntry({
  description: "Bundled OpenCode Zen provider plugin",
  id: PROVIDER_ID,
  name: "OpenCode Zen Provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenCode Zen",
      docsPath: "/providers/models",
      envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          applyConfig: (cfg) => applyOpencodeZenConfig(cfg),
          defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
          envVar: "OPENCODE_API_KEY",
          expectedProviders: ["opencode", "opencode-go"],
          flagName: "--opencode-zen-api-key",
          hint: "Shared API key for Zen + Go catalogs",
          label: "OpenCode Zen catalog",
          methodId: "api-key",
          noteMessage: [
            "OpenCode uses one API key across the Zen and Go catalogs.",
            "Zen provides access to Claude, GPT, Gemini, and more models.",
            "Get your API key at: https://opencode.ai/auth",
            "Choose the Zen catalog when you want the curated multi-model proxy.",
          ].join("\n"),
          noteTitle: "OpenCode",
          optionKey: "opencodeZenApiKey",
          profileIds: ["opencode:default", "opencode-go:default"],
          promptMessage: "Enter OpenCode API key",
          providerId: PROVIDER_ID,
          wizard: {
            choiceId: "opencode-zen",
            choiceLabel: "OpenCode Zen catalog",
            groupHint: "Shared API key for Zen + Go catalogs",
            groupId: "opencode",
            groupLabel: "OpenCode",
          },
        }),
      ],
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId),
    });
  },
});
