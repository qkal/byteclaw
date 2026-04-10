import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  GOOGLE_GEMINI_DEFAULT_MODEL,
  applyGoogleGeminiModelDefault,
  normalizeGoogleModelId,
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiTransport,
} from "./api.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "google-gemini",
  }),
  ...buildProviderStreamFamilyHooks("google-thinking"),
};

export function registerGoogleProvider(api: OpenClawPluginApi) {
  api.registerProvider({
    id: "google",
    label: "Google AI Studio",
    docsPath: "/providers/models",
    hookAliases: ["google-antigravity", "google-vertex"],
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
        defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
        envVar: "GEMINI_API_KEY",
        expectedProviders: ["google"],
        flagName: "--gemini-api-key",
        hint: "AI Studio / Gemini API key",
        label: "Google Gemini API key",
        methodId: "api-key",
        optionKey: "geminiApiKey",
        promptMessage: "Enter Gemini API key",
        providerId: "google",
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google Gemini API key",
          groupHint: "Gemini API key + OAuth",
          groupId: "google",
          groupLabel: "Google",
        },
      }),
    ],
    normalizeTransport: ({ api, baseUrl }) => resolveGoogleGenerativeAiTransport({ api, baseUrl }),
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeGoogleProviderConfig(provider, providerConfig),
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        ctx,
        providerId: ctx.provider,
      }),
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  });
}
