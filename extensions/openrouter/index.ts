import {
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  definePluginEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  DEFAULT_CONTEXT_TOKENS,
  buildProviderReplayFamilyHooks,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildProviderStreamFamilyHooks,
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream-family";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { OPENROUTER_DEFAULT_MODEL_REF, applyOpenrouterConfig } from "./onboard.js";
import { buildOpenrouterProvider } from "./provider-catalog.js";
import { wrapOpenRouterProviderStream } from "./stream.js";

const PROVIDER_ID = "openrouter";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "moonshot/",
  "moonshotai/",
  "zai/",
] as const;

export default definePluginEntry({
  description: "Bundled OpenRouter provider plugin",
  id: "openrouter",
  name: "OpenRouter Provider",
  register(api) {
    const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
      family: "passthrough-gemini",
    });
    const _OPENROUTER_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("openrouter-thinking");
    function buildDynamicOpenRouterModel(
      ctx: ProviderResolveDynamicModelContext,
    ): ProviderRuntimeModel {
      const capabilities = getOpenRouterModelCapabilities(ctx.modelId);
      return {
        api: "openai-completions",
        baseUrl: OPENROUTER_BASE_URL,
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        id: ctx.modelId,
        input: capabilities?.input ?? ["text"],
        maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
        name: capabilities?.name ?? ctx.modelId,
        provider: PROVIDER_ID,
        reasoning: capabilities?.reasoning ?? false,
      };
    }

    function isOpenRouterCacheTtlModel(modelId: string): boolean {
      return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
    }

    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenRouter",
      docsPath: "/providers/models",
      envVars: ["OPENROUTER_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          applyConfig: (cfg) => applyOpenrouterConfig(cfg),
          defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
          envVar: "OPENROUTER_API_KEY",
          expectedProviders: ["openrouter"],
          flagName: "--openrouter-api-key",
          hint: "API key",
          label: "OpenRouter API key",
          methodId: "api-key",
          optionKey: "openrouterApiKey",
          promptMessage: "Enter OpenRouter API key",
          providerId: PROVIDER_ID,
          wizard: {
            choiceId: "openrouter-api-key",
            choiceLabel: "OpenRouter API key",
            groupHint: "API key",
            groupId: "openrouter",
            groupLabel: "OpenRouter",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const { apiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildOpenrouterProvider(),
              apiKey,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicOpenRouterModel(ctx),
      prepareDynamicModel: async (ctx) => {
        await loadOpenRouterModelCapabilities(ctx.modelId);
      },
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      resolveReasoningOutputMode: () => "native",
      isModernModelRef: () => true,
      wrapStreamFn: wrapOpenRouterProviderStream,
      isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId),
    });
    api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
  },
});
