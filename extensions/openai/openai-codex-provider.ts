import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  ProviderAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  type OAuthCredential,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { loginOpenAICodexOAuth } from "openclaw/plugin-sdk/provider-auth-login";
import {
  DEFAULT_CONTEXT_TOKENS,
  type ProviderPlugin,
  normalizeModelCompat,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { fetchCodexUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeLowercaseStringOrEmpty, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./default-models.js";
import { resolveCodexAuthIdentity } from "./openai-codex-auth-identity.js";
import { buildOpenAICodexProvider } from "./openai-codex-catalog.js";
import { CODEX_CLI_PROFILE_ID, readOpenAICodexCliOAuthProfile } from "./openai-codex-cli-auth.js";
import { buildOpenAIReplayPolicy } from "./replay-policy.js";
import {
  buildOpenAISyntheticCatalogEntry,
  cloneFirstTemplateModel,
  findCatalogTemplate,
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  matchesExactOrPrefix,
} from "./shared.js";
import {
  resolveOpenAITransportTurnState,
  resolveOpenAIWebSocketSessionPolicy,
} from "./transport-policy.js";

const PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_CODEX_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS = 1_050_000;
const OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS = 272_000;
const OPENAI_CODEX_GPT_54_MAX_TOKENS = 128_000;
const OPENAI_CODEX_GPT_54_COST = {
  cacheRead: 0.25,
  cacheWrite: 0,
  input: 2.5,
  output: 15,
} as const;
const OPENAI_CODEX_GPT_54_MINI_COST = {
  cacheRead: 0.075,
  cacheWrite: 0,
  input: 0.75,
  output: 4.5,
} as const;
const OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"] as const;
const OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  "gpt-5.1-codex-mini",
  ...OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
] as const;
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_GPT_53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS = 128_000;
const OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS = 128_000;
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"] as const;
const OPENAI_CODEX_XHIGH_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
  OPENAI_CODEX_GPT_53_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
  "gpt-5.2-codex",
  "gpt-5.1-codex",
] as const;
const OPENAI_CODEX_MODERN_MODEL_IDS = [
  OPENAI_CODEX_GPT_54_MODEL_ID,
  OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
  "gpt-5.2",
  "gpt-5.2-codex",
  OPENAI_CODEX_GPT_53_MODEL_ID,
  OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
] as const;
const OPENAI_RESPONSES_STREAM_HOOKS = buildProviderStreamFamilyHooks("openai-responses-defaults");

function normalizeCodexTransport(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const useCodexTransport =
    !model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl) || isOpenAICodexBaseUrl(model.baseUrl);
  const api =
    useCodexTransport && model.api === "openai-responses" ? "openai-codex-responses" : model.api;
  const baseUrl =
    api === "openai-codex-responses" && (!model.baseUrl || isOpenAIApiBaseUrl(model.baseUrl))
      ? OPENAI_CODEX_BASE_URL
      : model.baseUrl;
  if (api === model.api && baseUrl === model.baseUrl) {
    return model;
  }
  return {
    ...model,
    api,
    baseUrl,
  };
}

function resolveCodexForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);

  let templateIds: readonly string[];
  let patch: Partial<ProviderRuntimeModel> | undefined;
  if (lower === OPENAI_CODEX_GPT_54_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS;
    patch = {
      contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
      contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
      cost: OPENAI_CODEX_GPT_54_COST,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_CODEX_GPT_54_MINI_MODEL_ID) {
    templateIds = OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS;
    patch = {
      contextWindow: OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS,
      cost: OPENAI_CODEX_GPT_54_MINI_COST,
      maxTokens: OPENAI_CODEX_GPT_54_MAX_TOKENS,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_SPARK_MODEL_ID) {
    templateIds = [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS];
    patch = {
      api: "openai-codex-responses",
      baseUrl: OPENAI_CODEX_BASE_URL,
      contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      input: ["text"],
      maxTokens: OPENAI_CODEX_GPT_53_SPARK_MAX_TOKENS,
      provider: PROVIDER_ID,
      reasoning: true,
    };
  } else if (lower === OPENAI_CODEX_GPT_53_MODEL_ID) {
    templateIds = OPENAI_CODEX_TEMPLATE_MODEL_IDS;
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
      api: "openai-codex-responses",
      baseUrl: OPENAI_CODEX_BASE_URL,
      contextTokens: patch?.contextTokens,
      contextWindow: patch?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: trimmedModelId,
      input: ["text", "image"],
      maxTokens: patch?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      name: trimmedModelId,
      provider: PROVIDER_ID,
      reasoning: true,
    } as ProviderRuntimeModel)
  );
}

async function refreshOpenAICodexOAuthCredential(cred: OAuthCredential) {
  try {
    const { refreshOpenAICodexToken } = await import("./openai-codex-provider.runtime.js");
    const refreshed = await refreshOpenAICodexToken(cred.refresh);
    return {
      ...cred,
      ...refreshed,
      displayName: cred.displayName,
      email: cred.email,
      provider: PROVIDER_ID,
      type: "oauth" as const,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    if (
      /extract\s+accountid\s+from\s+token/i.test(message) &&
      typeof cred.access === "string" &&
      cred.access.trim().length > 0
    ) {
      return cred;
    }
    throw error;
  }
}

async function runOpenAICodexOAuth(ctx: ProviderAuthContext) {
  let creds;
  try {
    creds = await loginOpenAICodexOAuth({
      isRemote: ctx.isRemote,
      localBrowserMessage: "Complete sign-in in browser…",
      openUrl: ctx.openUrl,
      prompter: ctx.prompter,
      runtime: ctx.runtime,
    });
  } catch {
    return { profiles: [] };
  }
  if (!creds) {
    return { profiles: [] };
  }

  const identity = resolveCodexAuthIdentity({
    accessToken: creds.access,
    email: readStringValue(creds.email),
  });

  return buildOauthProviderAuthResult({
    access: creds.access,
    defaultModel: OPENAI_CODEX_DEFAULT_MODEL,
    email: identity.email,
    expires: creds.expires,
    profileName: identity.profileName,
    providerId: PROVIDER_ID,
    refresh: creds.refresh,
  });
}

function buildOpenAICodexAuthDoctorHint(ctx: { profileId?: string }) {
  if (ctx.profileId !== CODEX_CLI_PROFILE_ID) {
    return undefined;
  }
  return "Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.";
}

export function buildOpenAICodexProviderPlugin(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "OpenAI Codex",
    docsPath: "/providers/models",
    auth: [
      {
        hint: "Browser sign-in",
        id: "oauth",
        kind: "oauth",
        label: "ChatGPT OAuth",
        run: async (ctx) => await runOpenAICodexOAuth(ctx),
      },
    ],
    wizard: {
      setup: {
        choiceHint: "Browser sign-in",
        choiceId: "openai-codex",
        choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
        methodId: "oauth",
      },
    },
    catalog: {
      order: "profile",
      run: async (ctx) => {
        const authStore = ensureAuthProfileStore(ctx.agentDir, {
          allowKeychainPrompt: false,
        });
        if (listProfilesForProvider(authStore, PROVIDER_ID).length === 0) {
          return null;
        }
        return {
          provider: buildOpenAICodexProvider(),
        };
      },
    },
    resolveDynamicModel: (ctx) => resolveCodexForwardCompatModel(ctx),
    buildAuthDoctorHint: (ctx) => buildOpenAICodexAuthDoctorHint(ctx),
    resolveExternalAuthProfiles: (ctx) => {
      const profile = readOpenAICodexCliOAuthProfile({
        env: ctx.env,
        store: ctx.store,
      });
      return profile ? [{ ...profile, persistence: "runtime-only" }] : undefined;
    },
    supportsXHighThinking: ({ modelId }) =>
      matchesExactOrPrefix(modelId, OPENAI_CODEX_XHIGH_MODEL_IDS),
    isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_CODEX_MODERN_MODEL_IDS),
    preferRuntimeResolvedModel: (ctx) =>
      normalizeProviderId(ctx.provider) === PROVIDER_ID &&
      ctx.modelId.trim().toLowerCase() === OPENAI_CODEX_GPT_54_MODEL_ID,
    buildReplayPolicy: buildOpenAIReplayPolicy,
    prepareExtraParams: (ctx) => {
      const transport = ctx.extraParams?.transport;
      if (transport === "auto" || transport === "sse" || transport === "websocket") {
        return ctx.extraParams;
      }
      return {
        ...ctx.extraParams,
        transport: "auto",
      };
    },
    ...OPENAI_RESPONSES_STREAM_HOOKS,
    resolveTransportTurnState: (ctx) => resolveOpenAITransportTurnState(ctx),
    resolveWebSocketSessionPolicy: (ctx) => resolveOpenAIWebSocketSessionPolicy(ctx),
    resolveReasoningOutputMode: () => "native",
    normalizeResolvedModel: (ctx) => {
      if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) {
        return undefined;
      }
      return normalizeCodexTransport(ctx.model);
    },
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    fetchUsageSnapshot: async (ctx) =>
      await fetchCodexUsage(ctx.token, ctx.accountId, ctx.timeoutMs, ctx.fetchFn),
    refreshOAuth: async (cred) => await refreshOpenAICodexOAuthCredential(cred),
    augmentModelCatalog: (ctx) => {
      const gpt54Template = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_CODEX_GPT_54_TEMPLATE_MODEL_IDS,
      });
      const gpt54MiniTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: OPENAI_CODEX_GPT_54_MINI_TEMPLATE_MODEL_IDS,
      });
      const sparkTemplate = findCatalogTemplate({
        entries: ctx.entries,
        providerId: PROVIDER_ID,
        templateIds: [OPENAI_CODEX_GPT_53_MODEL_ID, ...OPENAI_CODEX_TEMPLATE_MODEL_IDS],
      });
      return [
        buildOpenAISyntheticCatalogEntry(gpt54Template, {
          contextTokens: OPENAI_CODEX_GPT_54_DEFAULT_CONTEXT_TOKENS,
          contextWindow: OPENAI_CODEX_GPT_54_NATIVE_CONTEXT_TOKENS,
          id: OPENAI_CODEX_GPT_54_MODEL_ID,
          input: ["text", "image"],
          reasoning: true,
        }),
        buildOpenAISyntheticCatalogEntry(gpt54MiniTemplate, {
          contextWindow: OPENAI_CODEX_GPT_54_MINI_CONTEXT_TOKENS,
          id: OPENAI_CODEX_GPT_54_MINI_MODEL_ID,
          input: ["text", "image"],
          reasoning: true,
        }),
        buildOpenAISyntheticCatalogEntry(sparkTemplate, {
          contextWindow: OPENAI_CODEX_GPT_53_SPARK_CONTEXT_TOKENS,
          id: OPENAI_CODEX_GPT_53_SPARK_MODEL_ID,
          input: ["text"],
          reasoning: true,
        }),
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    },
  };
}
