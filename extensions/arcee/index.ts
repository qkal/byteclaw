import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  type ProviderCatalogContext,
  readConfiguredProviderCatalogEntries,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  ARCEE_DEFAULT_MODEL_REF,
  ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
  applyArceeConfig,
  applyArceeOpenRouterConfig,
} from "./onboard.js";
import {
  buildArceeOpenRouterProvider,
  buildArceeProvider,
  isArceeOpenRouterBaseUrl,
  toArceeOpenRouterModelId,
} from "./provider-catalog.js";

const PROVIDER_ID = "arcee";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});
const ARCEE_WIZARD_GROUP = {
  groupHint: "Direct API or OpenRouter",
  groupId: "arcee",
  groupLabel: "Arcee AI",
} as const;

function buildArceeAuthMethods() {
  return [
    createProviderApiKeyAuthMethod({
      applyConfig: (cfg) => applyArceeConfig(cfg),
      defaultModel: ARCEE_DEFAULT_MODEL_REF,
      envVar: "ARCEEAI_API_KEY",
      expectedProviders: [PROVIDER_ID],
      flagName: "--arceeai-api-key",
      hint: "Direct access to Arcee platform",
      label: "Arcee AI API key",
      methodId: "arcee-platform",
      optionKey: "arceeaiApiKey",
      promptMessage: "Enter Arcee AI API key",
      providerId: PROVIDER_ID,
      wizard: {
        choiceHint: "Direct (chat.arcee.ai)",
        choiceId: "arceeai-api-key",
        choiceLabel: "Arcee AI API key",
        ...ARCEE_WIZARD_GROUP,
      },
    }),
    createProviderApiKeyAuthMethod({
      applyConfig: (cfg) => applyArceeOpenRouterConfig(cfg),
      defaultModel: ARCEE_OPENROUTER_DEFAULT_MODEL_REF,
      envVar: "OPENROUTER_API_KEY",
      expectedProviders: [PROVIDER_ID, "openrouter"],
      flagName: "--openrouter-api-key",
      hint: "Access Arcee models via OpenRouter",
      label: "OpenRouter API key",
      methodId: "openrouter",
      optionKey: "openrouterApiKey",
      profileId: "openrouter:default",
      promptMessage: "Enter OpenRouter API key",
      providerId: PROVIDER_ID,
      wizard: {
        choiceHint: "Via OpenRouter (openrouter.ai)",
        choiceId: "arceeai-openrouter",
        choiceLabel: "OpenRouter API key",
        ...ARCEE_WIZARD_GROUP,
      },
    }),
  ];
}

function readConfiguredArceeCatalogEntries(config: OpenClawConfig | undefined) {
  return readConfiguredProviderCatalogEntries({
    config,
    providerId: PROVIDER_ID,
  });
}

async function resolveArceeCatalog(ctx: ProviderCatalogContext) {
  const directKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
  if (directKey) {
    return { provider: { ...buildArceeProvider(), apiKey: directKey } };
  }

  const openRouterKey = ctx.resolveProviderApiKey("openrouter").apiKey;
  if (openRouterKey) {
    return { provider: { ...buildArceeOpenRouterProvider(), apiKey: openRouterKey } };
  }

  return null;
}

function normalizeArceeResolvedModel<T extends { baseUrl?: string; id: string }>(
  model: T,
): T | undefined {
  if (!isArceeOpenRouterBaseUrl(model.baseUrl)) {
    return undefined;
  }
  return {
    ...model,
    id: toArceeOpenRouterModelId(model.id),
  };
}

export default definePluginEntry({
  description: "Bundled Arcee AI provider plugin",
  id: PROVIDER_ID,
  name: "Arcee AI Provider",
  register(api) {
    api.registerProvider({
      augmentModelCatalog: ({ config }) => readConfiguredArceeCatalogEntries(config),
      auth: buildArceeAuthMethods(),
      catalog: {
        run: resolveArceeCatalog,
      },
      docsPath: "/providers/arcee",
      envVars: ["ARCEEAI_API_KEY", "OPENROUTER_API_KEY"],
      id: PROVIDER_ID,
      label: "Arcee AI",
      normalizeResolvedModel: ({ model }) => normalizeArceeResolvedModel(model),
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    });
  },
});
