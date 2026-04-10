import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  MINIMAX_OAUTH_MARKER,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { buildOauthProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { fetchMinimaxUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { MINIMAX_DEFAULT_MODEL_ID, isMiniMaxModernModelId } from "./api.js";
import type { MiniMaxRegion } from "./oauth.js";
import { applyMinimaxApiConfig, applyMinimaxApiConfigCn } from "./onboard.js";
import { buildMinimaxPortalProvider, buildMinimaxProvider } from "./provider-catalog.js";

const API_PROVIDER_ID = "minimax";
const PORTAL_PROVIDER_ID = "minimax-portal";
const PROVIDER_LABEL = "MiniMax";
const DEFAULT_MODEL = MINIMAX_DEFAULT_MODEL_ID;
const DEFAULT_BASE_URL_CN = "https://api.minimaxi.com/anthropic";
const DEFAULT_BASE_URL_GLOBAL = "https://api.minimax.io/anthropic";
const MINIMAX_USAGE_ENV_VAR_KEYS = [
  "MINIMAX_OAUTH_TOKEN",
  "MINIMAX_CODE_PLAN_KEY",
  "MINIMAX_CODING_API_KEY",
  "MINIMAX_API_KEY",
] as const;
const HYBRID_ANTHROPIC_OPENAI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  anthropicModelDropThinkingBlocks: true,
  family: "hybrid-anthropic-openai",
});
const MINIMAX_FAST_MODE_STREAM_HOOKS = buildProviderStreamFamilyHooks("minimax-fast-mode");

function resolveMinimaxReasoningOutputMode(): "native" {
  return "native";
}

function getDefaultBaseUrl(region: MiniMaxRegion): string {
  return region === "cn" ? DEFAULT_BASE_URL_CN : DEFAULT_BASE_URL_GLOBAL;
}

function apiModelRef(modelId: string): string {
  return `${API_PROVIDER_ID}/${modelId}`;
}

function portalModelRef(modelId: string): string {
  return `${PORTAL_PROVIDER_ID}/${modelId}`;
}

function buildPortalProviderCatalog(params: { baseUrl: string; apiKey: string }) {
  return {
    ...buildMinimaxPortalProvider(),
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
  };
}

function resolveApiCatalog(ctx: ProviderCatalogContext) {
  const {apiKey} = ctx.resolveProviderApiKey(API_PROVIDER_ID);
  if (!apiKey) {
    return null;
  }
  return {
    provider: {
      ...buildMinimaxProvider(ctx.env),
      apiKey,
    },
  };
}

function resolvePortalCatalog(ctx: ProviderCatalogContext) {
  const explicitProvider = ctx.config.models?.providers?.[PORTAL_PROVIDER_ID];
  const envApiKey = ctx.resolveProviderApiKey(PORTAL_PROVIDER_ID).apiKey;
  const authStore = ensureAuthProfileStore(ctx.agentDir, {
    allowKeychainPrompt: false,
  });
  const hasProfiles = listProfilesForProvider(authStore, PORTAL_PROVIDER_ID).length > 0;
  const explicitApiKey = normalizeOptionalString(explicitProvider?.apiKey);
  const apiKey = envApiKey ?? explicitApiKey ?? (hasProfiles ? MINIMAX_OAUTH_MARKER : undefined);
  if (!apiKey) {
    return null;
  }

  const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl);

  return {
    provider: buildPortalProviderCatalog({
      apiKey,
      baseUrl: explicitBaseUrl || buildMinimaxPortalProvider(ctx.env).baseUrl,
    }),
  };
}

function createOAuthHandler(region: MiniMaxRegion) {
  const defaultBaseUrl = getDefaultBaseUrl(region);
  const regionLabel = region === "cn" ? "CN" : "Global";

  return async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const progress = ctx.prompter.progress(`Starting MiniMax OAuth (${regionLabel})…`);
    try {
      const { loginMiniMaxPortalOAuth } = await import("./oauth.runtime.js");
      const result = await loginMiniMaxPortalOAuth({
        note: ctx.prompter.note,
        openUrl: ctx.openUrl,
        progress,
        region,
      });

      progress.stop("MiniMax OAuth complete");

      if (result.notification_message) {
        await ctx.prompter.note(result.notification_message, "MiniMax OAuth");
      }

      const baseUrl = result.resourceUrl || defaultBaseUrl;

      return buildOauthProviderAuthResult({
        access: result.access,
        configPatch: {
          agents: {
            defaults: {
              models: {
                [portalModelRef("MiniMax-M2.7")]: { alias: "minimax-m2.7" },
                [portalModelRef("MiniMax-M2.7-highspeed")]: {
                  alias: "minimax-m2.7-highspeed",
                },
              },
            },
          },
          models: {
            providers: {
              [PORTAL_PROVIDER_ID]: {
                baseUrl,
                models: [],
              },
            },
          },
        },
        defaultModel: portalModelRef(DEFAULT_MODEL),
        expires: result.expires,
        notes: [
          "MiniMax OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
          `Base URL defaults to ${defaultBaseUrl}. Override models.providers.${PORTAL_PROVIDER_ID}.baseUrl if needed.`,
          ...(result.notification_message ? [result.notification_message] : []),
        ],
        providerId: PORTAL_PROVIDER_ID,
        refresh: result.refresh,
      });
    } catch (error) {
      const errorMsg = formatErrorMessage(error);
      progress.stop(`MiniMax OAuth failed: ${errorMsg}`);
      await ctx.prompter.note(
        "If OAuth fails, verify your MiniMax account has portal access and try again.",
        "MiniMax OAuth",
      );
      throw error;
    }
  };
}

export function registerMinimaxProviders(api: OpenClawPluginApi) {
  api.registerProvider({
    id: API_PROVIDER_ID,
    label: PROVIDER_LABEL,
    hookAliases: ["minimax-cn"],
    docsPath: "/providers/minimax",
    envVars: ["MINIMAX_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        allowProfile: false,
        applyConfig: (cfg) => applyMinimaxApiConfig(cfg),
        defaultModel: apiModelRef(DEFAULT_MODEL),
        envVar: "MINIMAX_API_KEY",
        expectedProviders: ["minimax"],
        flagName: "--minimax-api-key",
        hint: "Global endpoint - api.minimax.io",
        label: "MiniMax API key (Global)",
        methodId: "api-global",
        optionKey: "minimaxApiKey",
        profileId: "minimax:global",
        promptMessage:
          "Enter MiniMax API key (sk-api- or sk-cp-)\nhttps://platform.minimax.io/user-center/basic-information/interface-key",
        providerId: API_PROVIDER_ID,
        wizard: {
          choiceHint: "Global endpoint - api.minimax.io",
          choiceId: "minimax-global-api",
          choiceLabel: "MiniMax API key (Global)",
          groupHint: "M2.7 (recommended)",
          groupId: "minimax",
          groupLabel: "MiniMax",
        },
      }),
      createProviderApiKeyAuthMethod({
        allowProfile: false,
        applyConfig: (cfg) => applyMinimaxApiConfigCn(cfg),
        defaultModel: apiModelRef(DEFAULT_MODEL),
        envVar: "MINIMAX_API_KEY",
        expectedProviders: ["minimax", "minimax-cn"],
        flagName: "--minimax-api-key",
        hint: "CN endpoint - api.minimaxi.com",
        label: "MiniMax API key (CN)",
        methodId: "api-cn",
        optionKey: "minimaxApiKey",
        profileId: "minimax:cn",
        promptMessage:
          "Enter MiniMax CN API key (sk-api- or sk-cp-)\nhttps://platform.minimaxi.com/user-center/basic-information/interface-key",
        providerId: API_PROVIDER_ID,
        wizard: {
          choiceHint: "CN endpoint - api.minimaxi.com",
          choiceId: "minimax-cn-api",
          choiceLabel: "MiniMax API key (CN)",
          groupHint: "M2.7 (recommended)",
          groupId: "minimax",
          groupLabel: "MiniMax",
        },
      }),
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => resolveApiCatalog(ctx),
    },
    resolveUsageAuth: async (ctx) => {
      const portalOauth = await ctx.resolveOAuthToken({ provider: PORTAL_PROVIDER_ID });
      if (portalOauth) {
        return portalOauth;
      }
      const apiKey = ctx.resolveApiKeyFromConfigAndStore({
        envDirect: MINIMAX_USAGE_ENV_VAR_KEYS.map((name) => ctx.env[name]),
        providerIds: [API_PROVIDER_ID, PORTAL_PROVIDER_ID],
      });
      return apiKey ? { token: apiKey } : null;
    },
    ...HYBRID_ANTHROPIC_OPENAI_REPLAY_HOOKS,
    ...MINIMAX_FAST_MODE_STREAM_HOOKS,
    resolveReasoningOutputMode: () => resolveMinimaxReasoningOutputMode(),
    isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
    fetchUsageSnapshot: async (ctx) =>
      await fetchMinimaxUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
  });

  api.registerProvider({
    id: PORTAL_PROVIDER_ID,
    label: PROVIDER_LABEL,
    hookAliases: ["minimax-portal-cn"],
    docsPath: "/providers/minimax",
    envVars: ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
    catalog: {
      run: async (ctx) => resolvePortalCatalog(ctx),
    },
    auth: [
      {
        hint: "Global endpoint - api.minimax.io",
        id: "oauth",
        kind: "device_code",
        label: "MiniMax OAuth (Global)",
        run: createOAuthHandler("global"),
        wizard: {
          choiceHint: "Global endpoint - api.minimax.io",
          choiceId: "minimax-global-oauth",
          choiceLabel: "MiniMax OAuth (Global)",
          groupHint: "M2.7 (recommended)",
          groupId: "minimax",
          groupLabel: "MiniMax",
        },
      },
      {
        hint: "CN endpoint - api.minimaxi.com",
        id: "oauth-cn",
        kind: "device_code",
        label: "MiniMax OAuth (CN)",
        run: createOAuthHandler("cn"),
        wizard: {
          choiceHint: "CN endpoint - api.minimaxi.com",
          choiceId: "minimax-cn-oauth",
          choiceLabel: "MiniMax OAuth (CN)",
          groupHint: "M2.7 (recommended)",
          groupId: "minimax",
          groupLabel: "MiniMax",
        },
      },
    ],
    ...HYBRID_ANTHROPIC_OPENAI_REPLAY_HOOKS,
    ...MINIMAX_FAST_MODE_STREAM_HOOKS,
    resolveReasoningOutputMode: () => resolveMinimaxReasoningOutputMode(),
    isModernModelRef: ({ modelId }) => isMiniMaxModernModelId(modelId),
  });
}
