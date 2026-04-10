import { lowercasePreservingWhitespace } from "../../shared/string-coerce.js";
import type { OpenRouterModelCapabilities } from "./openrouter-model-capabilities.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const XAI_BASE_URL = "https://api.x.ai/v1";
const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
const GOOGLE_GENERATIVE_AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_GEMINI_CLI_BASE_URL = "https://cloudcode-pa.googleapis.com";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_FALLBACK_COST = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };

interface ModelRegistryLike {
  find: (provider: string, modelId: string) => unknown;
}

interface DynamicModelContext {
  provider: string;
  modelId: string;
  modelRegistry: ModelRegistryLike;
}

type ResolvedModelLike = Record<string, unknown>;
interface NormalizedTransportLike {
  api?: string | null;
  baseUrl?: string;
}

interface ProviderRuntimeTestMockOptions {
  clearHookCache?: () => void;
  getOpenRouterModelCapabilities?: (modelId: string) => OpenRouterModelCapabilities | undefined;
  handledDynamicProviders?: readonly string[];
  loadOpenRouterModelCapabilities?: (modelId: string) => Promise<void>;
}

function findTemplate(
  ctx: { modelRegistry: ModelRegistryLike },
  provider: string,
  templateIds: readonly string[],
) {
  for (const templateId of templateIds) {
    const template = ctx.modelRegistry.find(provider, templateId) as ResolvedModelLike | null;
    if (template) {
      return template;
    }
  }
  return undefined;
}

function cloneTemplate(
  template: ResolvedModelLike | undefined,
  modelId: string,
  patch: ResolvedModelLike,
  fallback: ResolvedModelLike,
) {
  return {
    ...(template ?? fallback),
    id: modelId,
    name: modelId,
    ...patch,
  } as ResolvedModelLike;
}

function normalizeDynamicModel(params: { provider: string; model: ResolvedModelLike }) {
  if (params.provider !== "openai-codex") {
    return undefined;
  }
  const baseUrl = typeof params.model.baseUrl === "string" ? params.model.baseUrl : undefined;
  const nextApi =
    params.model.api === "openai-responses" &&
    (!baseUrl || baseUrl === OPENAI_BASE_URL || baseUrl === OPENAI_CODEX_BASE_URL)
      ? "openai-codex-responses"
      : params.model.api;
  const nextBaseUrl =
    nextApi === "openai-codex-responses" && (!baseUrl || baseUrl === OPENAI_BASE_URL)
      ? OPENAI_CODEX_BASE_URL
      : baseUrl;
  if (nextApi !== params.model.api || nextBaseUrl !== baseUrl) {
    return { ...params.model, api: nextApi, baseUrl: nextBaseUrl };
  }
  return undefined;
}

function normalizeTransport(params: {
  provider: string;
  context: { api?: string | null; baseUrl?: string };
}): NormalizedTransportLike | undefined {
  const isNativeOpenAiTransport =
    params.context.api === "openai-completions" &&
    (params.context.baseUrl === OPENAI_BASE_URL ||
      (params.provider === "openai" && !params.context.baseUrl));
  const isNativeXaiTransport =
    params.context.api === "openai-completions" &&
    (params.context.baseUrl === XAI_BASE_URL ||
      (params.provider === "xai" && !params.context.baseUrl));
  if (
    params.context.api === "google-generative-ai" &&
    params.context.baseUrl === "https://generativelanguage.googleapis.com"
  ) {
    return {
      api: params.context.api,
      baseUrl: GOOGLE_GENERATIVE_AI_BASE_URL,
    };
  }
  if (isNativeOpenAiTransport) {
    return {
      api: "openai-responses",
      baseUrl: params.context.baseUrl,
    };
  }
  if (isNativeXaiTransport) {
    return {
      api: "openai-responses",
      baseUrl: params.context.baseUrl,
    };
  }
  return undefined;
}

function buildDynamicModel(
  params: DynamicModelContext,
  options: Required<
    Pick<
      ProviderRuntimeTestMockOptions,
      "getOpenRouterModelCapabilities" | "loadOpenRouterModelCapabilities"
    >
  >,
) {
  const modelId = params.modelId.trim();
  const lower = lowercasePreservingWhitespace(modelId);
  switch (params.provider) {
    case "openrouter": {
      const capabilities = options.getOpenRouterModelCapabilities(modelId);
      return {
        api: "openai-completions" as const,
        baseUrl: OPENROUTER_BASE_URL,
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        cost: capabilities?.cost ?? OPENROUTER_FALLBACK_COST,
        id: modelId,
        input: capabilities?.input ?? (["text"] as const),
        maxTokens: capabilities?.maxTokens ?? DEFAULT_MAX_TOKENS,
        name: capabilities?.name ?? modelId,
        provider: "openrouter",
        reasoning: capabilities?.reasoning ?? false,
      };
    }
    case "github-copilot": {
      const existing = params.modelRegistry.find("github-copilot", lower);
      if (existing) {
        return undefined;
      }
      const template = findTemplate(params, "github-copilot", ["gpt-5.4"]);
      if (lower === "gpt-5.4" && template) {
        return cloneTemplate(
          template,
          modelId,
          {},
          {
            api: "openai-responses",
            contextWindow: 128_000,
            cost: OPENROUTER_FALLBACK_COST,
            input: ["text", "image"],
            maxTokens: DEFAULT_MAX_TOKENS,
            provider: "github-copilot",
            reasoning: false,
          },
        );
      }
      return {
        api: lower.includes("claude") ? "anthropic-messages" : "openai-responses",
        contextWindow: 128_000,
        cost: OPENROUTER_FALLBACK_COST,
        id: modelId,
        input: ["text", "image"],
        maxTokens: DEFAULT_MAX_TOKENS,
        name: modelId,
        provider: "github-copilot",
        reasoning: /^o[13](\b|$)/.test(lower),
      };
    }
    case "openai-codex": {
      const template =
        lower === "gpt-5.4"
          ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.4"])
          : lower === "gpt-5.4-mini"
            ? findTemplate(params, "openai-codex", [
                "gpt-5.4",
                "gpt-5.1-codex-mini",
                "gpt-5.3-codex",
                "gpt-5.4",
              ])
            : lower === "gpt-5.3-codex-spark"
              ? findTemplate(params, "openai-codex", ["gpt-5.4", "gpt-5.4"])
              : findTemplate(params, "openai-codex", ["gpt-5.4"]);
      const fallback = {
        api: "openai-codex-responses",
        baseUrl: OPENAI_CODEX_BASE_URL,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        cost: OPENROUTER_FALLBACK_COST,
        input: ["text", "image"],
        maxTokens: DEFAULT_CONTEXT_WINDOW,
        provider: "openai-codex",
        reasoning: true,
      };
      if (lower === "gpt-5.4") {
        return cloneTemplate(
          template,
          modelId,
          {
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            contextTokens: 272_000,
            contextWindow: 1_050_000,
            cost: { cacheRead: 0.25, cacheWrite: 0, input: 2.5, output: 15 },
            maxTokens: 128_000,
            provider: "openai-codex",
          },
          fallback,
        );
      }
      if (lower === "gpt-5.4-mini") {
        return cloneTemplate(
          template,
          modelId,
          {
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            contextWindow: 272_000,
            cost: { cacheRead: 0.075, cacheWrite: 0, input: 0.75, output: 4.5 },
            maxTokens: 128_000,
            provider: "openai-codex",
          },
          fallback,
        );
      }
      if (lower === "gpt-5.3-codex-spark") {
        return cloneTemplate(
          template,
          modelId,
          {
            api: "openai-codex-responses",
            baseUrl: OPENAI_CODEX_BASE_URL,
            contextWindow: 128_000,
            cost: OPENROUTER_FALLBACK_COST,
            input: ["text"],
            maxTokens: 128_000,
            provider: "openai-codex",
            reasoning: true,
          },
          fallback,
        );
      }
      return undefined;
    }
    case "openai": {
      const templateIds =
        lower === "gpt-5.4"
          ? ["gpt-5.4"]
          : lower === "gpt-5.4-pro"
            ? ["gpt-5.4-pro", "gpt-5.4"]
            : lower === "gpt-5.4-mini"
              ? ["gpt-5.4-mini"]
              : lower === "gpt-5.4-nano"
                ? ["gpt-5.4-nano", "gpt-5.4-mini"]
                : undefined;
      if (!templateIds) {
        return undefined;
      }
      const template = findTemplate(params, "openai", templateIds);
      const patch =
        lower === "gpt-5.4"
          ? {
              api: "openai-responses",
              baseUrl: OPENAI_BASE_URL,
              contextWindow: 272_000,
              cost: { cacheRead: 0.25, cacheWrite: 0, input: 2.5, output: 15 },
              input: ["text", "image"],
              maxTokens: 128_000,
              provider: "openai",
              reasoning: true,
            }
          : lower === "gpt-5.4-pro"
            ? {
                api: "openai-responses",
                baseUrl: OPENAI_BASE_URL,
                contextWindow: 1_050_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 30, output: 180 },
                input: ["text", "image"],
                maxTokens: 128_000,
                provider: "openai",
                reasoning: true,
              }
            : lower === "gpt-5.4-mini"
              ? {
                  api: "openai-responses",
                  baseUrl: OPENAI_BASE_URL,
                  contextWindow: 400_000,
                  cost: { cacheRead: 0.075, cacheWrite: 0, input: 0.75, output: 4.5 },
                  input: ["text", "image"],
                  maxTokens: 128_000,
                  provider: "openai",
                  reasoning: true,
                }
              : {
                  api: "openai-responses",
                  baseUrl: OPENAI_BASE_URL,
                  contextWindow: 400_000,
                  cost: { cacheRead: 0.02, cacheWrite: 0, input: 0.2, output: 1.25 },
                  input: ["text", "image"],
                  maxTokens: 128_000,
                  provider: "openai",
                  reasoning: true,
                };
      return cloneTemplate(template, modelId, patch, {
        api: "openai-responses",
        baseUrl: OPENAI_BASE_URL,
        contextWindow: patch.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        cost: OPENROUTER_FALLBACK_COST,
        input: ["text", "image"],
        maxTokens: patch.maxTokens ?? DEFAULT_CONTEXT_WINDOW,
        provider: "openai",
        reasoning: true,
      });
    }
    case "anthropic":
    case "claude-cli": {
      if (lower !== "claude-opus-4-6" && lower !== "claude-sonnet-4-6") {
        return undefined;
      }
      const template = findTemplate(
        params,
        "anthropic",
        lower === "claude-opus-4-6" ? ["claude-opus-4-6"] : ["claude-sonnet-4-6"],
      );
      return cloneTemplate(
        template,
        modelId,
        {
          api: "anthropic-messages",
          baseUrl: ANTHROPIC_BASE_URL,
          provider: params.provider,
          reasoning: true,
        },
        {
          api: "anthropic-messages",
          baseUrl: ANTHROPIC_BASE_URL,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          cost: OPENROUTER_FALLBACK_COST,
          input: ["text", "image"],
          maxTokens: DEFAULT_CONTEXT_WINDOW,
          provider: params.provider,
          reasoning: true,
        },
      );
    }
    case "google-antigravity": {
      if (lower !== "claude-opus-4-6-thinking") {
        return undefined;
      }
      return cloneTemplate(
        undefined,
        modelId,
        {
          api: "google-gemini-cli",
          baseUrl: GOOGLE_GEMINI_CLI_BASE_URL,
          input: ["text", "image"],
          provider: "google-antigravity",
          reasoning: true,
        },
        {
          api: "google-gemini-cli",
          baseUrl: GOOGLE_GEMINI_CLI_BASE_URL,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          cost: OPENROUTER_FALLBACK_COST,
          input: ["text", "image"],
          maxTokens: DEFAULT_MAX_TOKENS,
          provider: "google-antigravity",
          reasoning: true,
        },
      );
    }
    case "zai": {
      if (lower !== "glm-5") {
        return undefined;
      }
      const template = findTemplate(params, "zai", ["glm-4.7"]);
      return cloneTemplate(
        template,
        modelId,
        {
          api: "openai-completions",
          baseUrl: ZAI_BASE_URL,
          provider: "zai",
          reasoning: true,
        },
        {
          api: "openai-completions",
          baseUrl: ZAI_BASE_URL,
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          cost: OPENROUTER_FALLBACK_COST,
          input: ["text"],
          maxTokens: DEFAULT_CONTEXT_WINDOW,
          provider: "zai",
          reasoning: true,
        },
      );
    }
    default: {
      return undefined;
    }
  }
}

export function createProviderRuntimeTestMock(options: ProviderRuntimeTestMockOptions = {}) {
  const handledDynamicProviders = new Set(
    options.handledDynamicProviders ?? [
      "openrouter",
      "github-copilot",
      "openai-codex",
      "openai",
      "xai",
      "anthropic",
      "google-antigravity",
      "zai",
    ],
  );
  const getOpenRouterModelCapabilities =
    options.getOpenRouterModelCapabilities ?? (() => undefined);
  const loadOpenRouterModelCapabilities =
    options.loadOpenRouterModelCapabilities ?? (async () => {});

  return {
    applyProviderResolvedTransportWithPlugin: (params: {
      provider: string;
      config?: unknown;
      workspaceDir?: string;
      env?: NodeJS.ProcessEnv;
      context: { model: unknown };
    }) => {
      const model = params.context.model as ResolvedModelLike;
      const normalized = normalizeTransport({
        context: {
          api: model.api as string | null | undefined,
          baseUrl: model.baseUrl as string | undefined,
        },
        provider: params.provider,
      });
      if (!normalized) {
        return undefined;
      }
      const nextApi = normalized.api ?? model.api;
      const nextBaseUrl = normalized.baseUrl ?? model.baseUrl;
      if (nextApi === model.api && nextBaseUrl === model.baseUrl) {
        return undefined;
      }
      return {
        ...model,
        api: nextApi,
        baseUrl: nextBaseUrl,
      };
    },
    buildProviderUnknownModelHintWithPlugin: (params: { provider: string }) => {
      switch (params.provider) {
        case "ollama": {
          return (
            "Ollama requires authentication to be registered as a provider. " +
            'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
            "See: https://docs.openclaw.ai/providers/ollama"
          );
        }
        case "vllm": {
          return (
            "vLLM requires authentication to be registered as a provider. " +
            'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
            "See: https://docs.openclaw.ai/providers/vllm"
          );
        }
        default: {
          return undefined;
        }
      }
    },
    clearProviderRuntimeHookCache: options.clearHookCache ?? (() => {}),
    normalizeProviderResolvedModelWithPlugin: (params: {
      provider: string;
      context: { model: unknown };
    }) =>
      handledDynamicProviders.has(params.provider)
        ? normalizeDynamicModel({
            model: params.context.model as ResolvedModelLike,
            provider: params.provider,
          })
        : undefined,
    normalizeProviderTransportWithPlugin: (params: {
      provider: string;
      context: { api?: string | null; baseUrl?: string };
    }) => normalizeTransport(params),
    prepareProviderDynamicModel: async (params: {
      provider: string;
      context: { modelId: string };
    }) =>
      params.provider === "openrouter"
        ? await loadOpenRouterModelCapabilities(params.context.modelId)
        : undefined,
    resolveProviderRuntimePlugin: ({ provider }: { provider: string }) =>
      handledDynamicProviders.has(provider)
        ? {
            id: provider,
            normalizeResolvedModel: (ctx: { provider: string; model: ResolvedModelLike }) =>
              normalizeDynamicModel(ctx),
            prepareDynamicModel:
              provider === "openrouter"
                ? async ({ modelId }: { modelId: string }) => {
                    await loadOpenRouterModelCapabilities(modelId);
                  }
                : undefined,
            resolveDynamicModel: (ctx: DynamicModelContext) =>
              buildDynamicModel(ctx, {
                getOpenRouterModelCapabilities,
                loadOpenRouterModelCapabilities,
              }),
          }
        : undefined,
    runProviderDynamicModel: (params: {
      provider: string;
      context: { modelId: string; modelRegistry: ModelRegistryLike };
    }) =>
      handledDynamicProviders.has(params.provider)
        ? buildDynamicModel(
            {
              modelId: params.context.modelId,
              modelRegistry: params.context.modelRegistry,
              provider: params.provider,
            },
            {
              getOpenRouterModelCapabilities,
              loadOpenRouterModelCapabilities,
            },
          )
        : undefined,
    shouldPreferProviderRuntimeResolvedModel: (params: {
      provider: string;
      context: { modelId: string };
    }) =>
      params.provider === "openai-codex" &&
      params.context.modelId.trim().toLowerCase() === "gpt-5.4",
  };
}
