import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  DEFAULT_CONTEXT_TOKENS,
  buildProviderReplayFamilyHooks,
  cloneFirstTemplateModel,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { isFireworksKimiModelId } from "./model-id.js";
import { FIREWORKS_DEFAULT_MODEL_REF, applyFireworksConfig } from "./onboard.js";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
  buildFireworksProvider,
} from "./provider-catalog.js";
import { wrapFireworksProviderStream } from "./stream.js";

const PROVIDER_ID = "fireworks";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

function resolveFireworksDynamicModel(ctx: ProviderResolveDynamicModelContext) {
  const modelId = ctx.modelId.trim();
  if (!modelId) {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      ctx,
      modelId,
      patch: {
        provider: PROVIDER_ID,
        reasoning: !isFireworksKimiModelId(modelId),
      },
      providerId: PROVIDER_ID,
      templateIds: [FIREWORKS_DEFAULT_MODEL_ID],
    }) ??
    normalizeModelCompat({
      api: "openai-completions",
      baseUrl: FIREWORKS_BASE_URL,
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: modelId,
      input: ["text", "image"],
      maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS || DEFAULT_CONTEXT_TOKENS,
      name: modelId,
      provider: PROVIDER_ID,
      reasoning: !isFireworksKimiModelId(modelId),
    })
  );
}

export default defineSingleProviderPluginEntry({
  description: "Bundled Fireworks AI provider plugin",
  id: PROVIDER_ID,
  name: "Fireworks Provider",
  provider: {
    label: "Fireworks",
    aliases: ["fireworks-ai"],
    docsPath: "/providers/fireworks",
    auth: [
      {
        applyConfig: (cfg) => applyFireworksConfig(cfg),
        defaultModel: FIREWORKS_DEFAULT_MODEL_REF,
        envVar: "FIREWORKS_API_KEY",
        flagName: "--fireworks-api-key",
        hint: "API key",
        label: "Fireworks API key",
        methodId: "api-key",
        optionKey: "fireworksApiKey",
        promptMessage: "Enter Fireworks API key",
      },
    ],
    catalog: {
      allowExplicitBaseUrl: true,
      buildProvider: buildFireworksProvider,
    },
    ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    wrapStreamFn: wrapFireworksProviderStream,
    resolveDynamicModel: (ctx) => resolveFireworksDynamicModel(ctx),
    isModernModelRef: () => true,
  },
});
