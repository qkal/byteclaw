import { Type } from "@sinclair/typebox";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  type WebSearchProviderPlugin,
  type WebSearchProviderSetupContext,
  formatCliCommand,
  getScopedCredentialValue,
  mergeScopedSearchConfig,
  normalizeCacheKey,
  readCache,
  readNumberParam,
  readStringParam,
  resolveCacheTtlMs,
  resolveProviderWebSearchPluginConfig,
  resolveTimeoutSeconds,
  resolveWebSearchProviderCredential,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  requestXaiWebSearch,
  resolveXaiInlineCitations,
  resolveXaiWebSearchModel,
} from "./src/web-search-shared.js";
import {
  resolveEffectiveXSearchConfig,
  setPluginXSearchConfigValue,
} from "./src/x-search-config.js";
import { XAI_DEFAULT_X_SEARCH_MODEL } from "./src/x-search-shared.js";

const XAI_WEB_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

const X_SEARCH_MODEL_OPTIONS = [
  {
    hint: "default · fast, no reasoning",
    label: XAI_DEFAULT_X_SEARCH_MODEL,
    value: XAI_DEFAULT_X_SEARCH_MODEL,
  },
  {
    hint: "fast with reasoning",
    label: "grok-4-1-fast",
    value: "grok-4-1-fast",
  },
] as const;

function resolveXSearchConfigRecord(
  config?: WebSearchProviderSetupContext["config"],
): Record<string, unknown> | undefined {
  return resolveEffectiveXSearchConfig(config);
}

async function runXaiSearchProviderSetup(
  ctx: WebSearchProviderSetupContext,
): Promise<WebSearchProviderSetupContext["config"]> {
  const existingXSearch = resolveXSearchConfigRecord(ctx.config);
  if (existingXSearch?.enabled === false) {
    return ctx.config;
  }

  await ctx.prompter.note(
    [
      "x_search lets your agent search X (formerly Twitter) posts via xAI.",
      "It reuses the same xAI API key you just configured for Grok web search.",
      `You can change this later with ${formatCliCommand("openclaw configure --section web")}.`,
    ].join("\n"),
    "X search",
  );

  const enableChoice = await ctx.prompter.select<"yes" | "skip">({
    initialValue: existingXSearch?.enabled === true || ctx.quickstartDefaults ? "yes" : "skip",
    message: "Enable x_search too?",
    options: [
      {
        hint: "Search X posts with the same xAI key",
        label: "Yes, enable x_search",
        value: "yes",
      },
      {
        hint: "Keep Grok web_search only",
        label: "Skip for now",
        value: "skip",
      },
    ],
  });

  if (enableChoice === "skip") {
    return ctx.config;
  }

  const existingModel =
    typeof existingXSearch?.model === "string" && existingXSearch.model.trim()
      ? existingXSearch.model.trim()
      : "";
  const knownModel = X_SEARCH_MODEL_OPTIONS.find((entry) => entry.value === existingModel)?.value;
  const modelPick = await ctx.prompter.select<string>({
    initialValue: knownModel ?? XAI_DEFAULT_X_SEARCH_MODEL,
    message: "Grok model for x_search",
    options: [
      ...X_SEARCH_MODEL_OPTIONS,
      { hint: "", label: "Enter custom model name", value: "__custom__" },
    ],
  });

  let model = modelPick;
  if (modelPick === "__custom__") {
    const customModel = await ctx.prompter.text({
      initialValue: existingModel || XAI_DEFAULT_X_SEARCH_MODEL,
      message: "Custom Grok model name",
      placeholder: XAI_DEFAULT_X_SEARCH_MODEL,
    });
    model = customModel.trim() || XAI_DEFAULT_X_SEARCH_MODEL;
  }

  const next = structuredClone(ctx.config);
  setPluginXSearchConfigValue(next, "enabled", true);
  setPluginXSearchConfigValue(next, "model", model || XAI_DEFAULT_X_SEARCH_MODEL);
  return next;
}

function runXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `grok:${params.model}:${String(params.inlineCitations)}:${params.query}`,
  );
  const cached = readCache(XAI_WEB_SEARCH_CACHE, cacheKey);
  if (cached) {
    return Promise.resolve({ ...cached.value, cached: true });
  }

  return (async () => {
    const startedAt = Date.now();
    const result = await requestXaiWebSearch({
      apiKey: params.apiKey,
      inlineCitations: params.inlineCitations,
      model: params.model,
      query: params.query,
      timeoutSeconds: params.timeoutSeconds,
    });
    const payload = buildXaiWebSearchPayload({
      citations: result.citations,
      content: result.content,
      inlineCitations: result.inlineCitations,
      model: params.model,
      provider: "grok",
      query: params.query,
      tookMs: Date.now() - startedAt,
    });

    writeCache(XAI_WEB_SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  })();
}

function resolveXaiToolSearchConfig(ctx: {
  config?: Record<string, unknown>;
  searchConfig?: Record<string, unknown>;
}) {
  return mergeScopedSearchConfig(
    ctx.searchConfig,
    "grok",
    resolveProviderWebSearchPluginConfig(ctx.config, "xai"),
  );
}

function resolveXaiWebSearchCredential(searchConfig?: Record<string, unknown>): string | undefined {
  return resolveWebSearchProviderCredential({
    credentialValue: getScopedCredentialValue(searchConfig, "grok"),
    envVars: ["XAI_API_KEY"],
    path: "tools.web.search.grok.apiKey",
  });
}

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    autoDetectOrder: 30,
    createTool: (ctx) => {
      const searchConfig = resolveXaiToolSearchConfig(ctx);
      return {
        description:
          "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
        execute: async (args: Record<string, unknown>) => {
          const apiKey = resolveXaiWebSearchCredential(searchConfig);

          if (!apiKey) {
            return {
              error: "missing_xai_api_key",
              message:
                "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
              docs: "https://docs.openclaw.ai/tools/web",
            };
          }

          const query = readStringParam(args, "query", { required: true });
          void readNumberParam(args, "count", { integer: true });

          return await runXaiWebSearch({
            query,
            model: resolveXaiWebSearchModel(searchConfig),
            apiKey,
            timeoutSeconds: resolveTimeoutSeconds(
              searchConfig?.timeoutSeconds,
              DEFAULT_TIMEOUT_SECONDS,
            ),
            inlineCitations: resolveXaiInlineCitations(searchConfig),
            cacheTtlMs: resolveCacheTtlMs(searchConfig?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
          });
        },
        parameters: Type.Object({
          query: Type.String({ description: "Search query string." }),
          count: Type.Optional(
            Type.Number({
              description: "Number of results to return (1-10).",
              minimum: 1,
              maximum: 10,
            }),
          ),
        }),
      };
    },
    credentialLabel: "xAI API key",
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    envVars: ["XAI_API_KEY"],
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "xai")?.apiKey,
    getCredentialValue: (searchConfig?: Record<string, unknown>) =>
      getScopedCredentialValue(searchConfig, "grok"),
    hint: "Requires xAI API key · xAI web-grounded responses",
    id: "grok",
    inactiveSecretPaths: ["plugins.entries.xai.config.webSearch.apiKey"],
    label: "Grok (xAI)",
    onboardingScopes: ["text-inference"],
    placeholder: "xai-...",
    runSetup: runXaiSearchProviderSetup,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "xai", "apiKey", value);
    },
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) =>
      setScopedCredentialValue(searchConfigTarget, "grok", value),
    signupUrl: "https://console.x.ai/",
  };
}

export const __testing = {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  requestXaiWebSearch,
  resolveXaiInlineCitations,
  resolveXaiToolSearchConfig,
  resolveXaiWebSearchCredential,
  resolveXaiWebSearchModel,
};
