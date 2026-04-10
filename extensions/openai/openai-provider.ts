import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  DEFAULT_CONTEXT_TOKENS,
  type ProviderPlugin,
  normalizeModelCompat,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { OPENAI_DEFAULT_MODEL, applyOpenAIConfig } from "./default-models.js";
import { buildOpenAIReplayPolicy } from "./replay-policy.js";
import {
  buildOpenAISyntheticCatalogEntry,
  cloneFirstTemplateModel,
  findCatalogTemplate,
  isOpenAIApiBaseUrl,
  matchesExactOrPrefix,
} from "./shared.js";
import {
  resolveOpenAITransportTurnState,
  resolveOpenAIWebSocketSessionPolicy,
} from "./transport-policy.js";

const PROVIDER_ID = "openai";
const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_GPT_54_NANO_MODEL_ID = "gpt-5.4-nano";
const OPENAI_GPT_54_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_PRO_CONTEXT_TOKENS = 1_050_000;
const OPENAI_GPT_54_MINI_CONTEXT_TOKENS = 400_000;
const OPENAI_GPT_54_NANO_CONTEXT_TOKENS = 400_000;
const OPENAI_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_GPT_54_COST = { cacheRead: 0.25, cacheWrite: 0, input: 2.5, output: 15 } as const;
const OPENAI_GPT_54_PRO_COST = { cacheRead: 0, cacheWrite: 0, input: 30, output: 180 } as const;
const OPENAI_GPT_54_MINI_COST = {
  cacheRead: 0.075,
  cacheWrite: 0,
  input: 0.75,
  output: 4.5,
} as const;
const OPENAI_GPT_54_NANO_COST = {
  cacheRead: 0.02,
  cacheWrite: 0,
  input: 0.2,
  output: 1.25,
} as const;
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.2"] as const;
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = ["gpt-5.2-pro", "gpt-5.2"] as const;
const OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS = ["gpt-5-mini"] as const;
const OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS = ["gpt-5-nano", "gpt-5-mini"] as const;
const OPENAI_XHIGH_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
] as const;
const OPENAI_MODERN_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
] as const;
const OPENAI_DIRECT_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SUPPRESSED_SPARK_PROVIDERS = new Set(["openai", "azure-openai-responses"]);
const OPENAI_RESPONSES_STREAM_HOOKS = buildProviderStreamFamilyHooks("openai-responses-defaults");

function shouldUseOpenAIResponsesTransport(params: {
  provider: string;
  api?: string | null;
  baseUrl?: string;
}): boolean {
  if (params.api !== "openai-completions") {
    return false;
  }
  const isOwnerProvider = normalizeProviderId(params.provider) === PROVIDER_ID;
  if (isOwnerProvider) {
    return !params.baseUrl || isOpenAIApiBaseUrl(params.baseUrl);
  }
  return typeof params.baseUrl === "string" && isOpenAIApiBaseUrl(params.baseUrl);
}

function normalizeOpenAITransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const useResponsesTransport = shouldUseOpenAIResponsesTransport({
    api: model.api,
    baseUrl: model.baseUrl,
    provider: model.provider,
  });

  if (!useResponsesTransport) {
    return model;
  }

  return {
    ...model,
    api: "openai-responses",
  };
}

function resolveOpenAIGpt54ForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
  let templateIds: readonly string[];
  let patch: Partial<ProviderRuntimeModel>;
  if (lower === OPENAI_GPT_54_MODEL_ID) {
    templateIds = OPENAI_GPT_54_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
      cost: OPENAI_GPT_54_COST,
      input: ["text", "image"],
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
      provider: PROVIDER_ID,
      reasoning: true,
    };
  } else if (lower === OPENAI_GPT_54_PRO_MODEL_ID) {
    templateIds = OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: OPENAI_GPT_54_PRO_CONTEXT_TOKENS,
      cost: OPENAI_GPT_54_PRO_COST,
      input: ["text", "image"],
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
      provider: PROVIDER_ID,
      reasoning: true,
    };
  } else if (lower === OPENAI_GPT_54_MINI_MODEL_ID) {
    templateIds = OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: OPENAI_GPT_54_MINI_CONTEXT_TOKENS,
      cost: OPENAI_GPT_54_MINI_COST,
      input: ["text", "image"],
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
      provider: PROVIDER_ID,
      reasoning: true,
    };
  } else if (lower === OPENAI_GPT_54_NANO_MODEL_ID) {
    templateIds = OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS;
    patch = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: OPENAI_GPT_54_NANO_CONTEXT_TOKENS,
      cost: OPENAI_GPT_54_NANO_COST,
      input: ["text", "image"],
      maxTokens: OPENAI_GPT_54_MAX_TOKENS,
      provider: PROVIDER_ID,
      reasoning: true,
    };
  } else {
    return undefined;
  }

  return (
    cloneFirstTemplateModel({
      ctx,
      modelId: trimmedModelId,
      patch,
      providerId: PROVIDER_ID,
      templateIds,
    }) ??
    normalizeModelCompat({
      id: trimmedModelId,
      name: trimmedModelId,
      ...patch,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      contextWindow: patch.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      maxTokens: patch.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    } as ProviderRuntimeModel)
  );
}

export function buildOpenAIProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        applyConfig: (cfg) => applyOpenAIConfig(cfg),
        defaultModel: OPENAI_DEFAULT_MODEL,
        envVar: "OPENAI_API_KEY",
        expectedProviders: ["openai"],
        flagName: "--openai-api-key",
        hint: "Direct OpenAI API key",
        label: "OpenAI API key",
        methodId: "api-key",
        optionKey: "openaiApiKey",
        promptMessage: "Enter OpenAI API key",
        providerId: PROVIDER_ID,
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          groupHint: "Codex OAuth + API key",
          groupId: "openai",
          groupLabel: "OpenAI",
        },
      }),
    ],
    resolveDynamicModel: (ctx) => resolveOpenAIGpt54ForwardCompatModel(ctx),
    normalizeResolvedModel: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      return normalizeOpenAITransport(ctx.model);
    },
    normalizeTransport: ({ provider, api, baseUrl }) =>
      shouldUseOpenAIResponsesTransport({ api, baseUrl, provider })
        ? { api: "openai-responses", baseUrl }
        : undefined,
    buildReplayPolicy: buildOpenAIReplayPolicy,
    prepareExtraParams: (ctx) => {
      const transport = ctx.extraParams?.transport;
      const hasSupportedTransport =
        transport === "auto" || transport === "sse" || transport === "websocket";
      const hasExplicitWarmup = typeof ctx.extraParams?.openaiWsWarmup === "boolean";
      if (hasSupportedTransport && hasExplicitWarmup) {
        return ctx.extraParams;
      }
      return {
        ...ctx.extraParams,
        ...(hasSupportedTransport ? {} : { transport: "auto" }),
        ...(hasExplicitWarmup ? {} : { openaiWsWarmup: true }),
      };
    },
    ...OPENAI_RESPONSES_STREAM_HOOKS,
    matchesContextOverflowError: ({ errorMessage }) =>
      /content_filter.*(?:prompt|input).*(?:too long|exceed)/i.test(errorMessage),
    resolveTransportTurnState: (ctx) => resolveOpenAITransportTurnState(ctx),
    resolveWebSocketSessionPolicy: (ctx) => resolveOpenAIWebSocketSessionPolicy(ctx),
    resolveReasoningOutputMode: () => "native",
    supportsXHighThinking: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_XHIGH_MODEL_IDS),
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_MODERN_MODEL_IDS),
    buildMissingAuthMessage: (ctx) => {
      if (ctx.provider !== PROVIDER_ID || ctx.listProfileIds("openai-codex").length === 0) {
        return undefined;
      }
      return 'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.';
    },
    suppressBuiltInModel: (ctx) => {
      if (
        !SUPPRESSED_SPARK_PROVIDERS.has(normalizeProviderId(ctx.provider)) ||
        normalizeLowercaseStringOrEmpty(ctx.modelId) !== OPENAI_DIRECT_SPARK_MODEL_ID
      ) {
        return undefined;
      }
      return {
        errorMessage: `Unknown model: ${ctx.provider}/${OPENAI_DIRECT_SPARK_MODEL_ID}. ${OPENAI_DIRECT_SPARK_MODEL_ID} is only supported via openai-codex OAuth. Use openai-codex/${OPENAI_DIRECT_SPARK_MODEL_ID}.`,
        suppress: true,
      };
    },
    augmentModelCatalog: (ctx) => {
      const openAiGpt54Template = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54ProTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54MiniTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS,
      });
      const openAiGpt54NanoTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS,
      });
      return [
        buildOpenAISyntheticCatalogEntry(openAiGpt54Template, {
          contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
          id: OPENAI_GPT_54_MODEL_ID,
          input: ["text", "image"],
          reasoning: true,
        }),
        buildOpenAISyntheticCatalogEntry(openAiGpt54ProTemplate, {
          contextWindow: OPENAI_GPT_54_PRO_CONTEXT_TOKENS,
          id: OPENAI_GPT_54_PRO_MODEL_ID,
          input: ["text", "image"],
          reasoning: true,
        }),
        buildOpenAISyntheticCatalogEntry(openAiGpt54MiniTemplate, {
          contextWindow: OPENAI_GPT_54_MINI_CONTEXT_TOKENS,
          id: OPENAI_GPT_54_MINI_MODEL_ID,
          input: ["text", "image"],
          reasoning: true,
        }),
        buildOpenAISyntheticCatalogEntry(openAiGpt54NanoTemplate, {
          contextWindow: OPENAI_GPT_54_NANO_CONTEXT_TOKENS,
          id: OPENAI_GPT_54_NANO_MODEL_ID,
          input: ["text", "image"],
          reasoning: true,
        }),
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}
