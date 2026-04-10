import { Type } from "@sinclair/typebox";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  type SearchConfigRecord,
  type WebSearchCredentialResolutionSource,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  buildSearchCacheKey,
  getScopedCredentialValue,
  isoToPerplexityDate,
  mergeScopedSearchConfig,
  normalizeFreshness,
  normalizeToIsoDate,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  throwWebSearchApiError,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

interface PerplexityConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

type PerplexityTransport = "search_api" | "chat_completions";
type PerplexityBaseUrlHint = "direct" | "openrouter";

interface PerplexitySearchResponse {
  choices?: {
    message?: {
      content?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        url_citation?: {
          url?: string;
        };
      }>;
    };
  }[];
  citations?: string[];
}

interface PerplexitySearchApiResponse {
  results?: {
    title?: string;
    url?: string;
    snippet?: string;
    date?: string;
  }[];
}

function resolvePerplexityConfig(searchConfig?: SearchConfigRecord): PerplexityConfig {
  const perplexity = searchConfig?.perplexity;
  return perplexity && typeof perplexity === "object" && !Array.isArray(perplexity)
    ? (perplexity as PerplexityConfig)
    : {};
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(apiKey);
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: "config" | "perplexity_env" | "openrouter_env" | "none";
} {
  const fromConfig = readConfiguredSecretString(
    perplexity?.apiKey,
    "tools.web.search.perplexity.apiKey",
  );
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }
  const fromPerplexityEnv = readProviderEnvValue(["PERPLEXITY_API_KEY"]);
  if (fromPerplexityEnv) {
    return { apiKey: fromPerplexityEnv, source: "perplexity_env" };
  }
  const fromOpenRouterEnv = readProviderEnvValue(["OPENROUTER_API_KEY"]);
  if (fromOpenRouterEnv) {
    return { apiKey: fromOpenRouterEnv, source: "openrouter_env" };
  }
  return { apiKey: undefined, source: "none" };
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  authSource: "config" | "perplexity_env" | "openrouter_env" | "none" = "none",
  configuredKey?: string,
): string {
  const fromConfig = normalizeOptionalString(perplexity?.baseUrl) ?? "";
  if (fromConfig) {
    return fromConfig;
  }
  if (authSource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (authSource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (authSource === "config") {
    return inferPerplexityBaseUrlFromApiKey(configuredKey) === "openrouter"
      ? DEFAULT_PERPLEXITY_BASE_URL
      : PERPLEXITY_DIRECT_BASE_URL;
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const model = normalizeOptionalString(perplexity?.model) ?? "";
  return model || DEFAULT_PERPLEXITY_MODEL;
}

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  try {
    return (
      normalizeLowercaseStringOrEmpty(new URL(baseUrl.trim()).hostname) === "api.perplexity.ai"
    );
  } catch {
    return false;
  }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function resolvePerplexityTransport(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: "config" | "perplexity_env" | "openrouter_env" | "none";
  baseUrl: string;
  model: string;
  transport: PerplexityTransport;
} {
  const auth = resolvePerplexityApiKey(perplexity);
  const baseUrl = resolvePerplexityBaseUrl(perplexity, auth.source, auth.apiKey);
  const model = resolvePerplexityModel(perplexity);
  const hasLegacyOverride = Boolean(
    normalizeOptionalString(perplexity?.baseUrl) || normalizeOptionalString(perplexity?.model),
  );
  return {
    ...auth,
    baseUrl,
    model,
    transport:
      hasLegacyOverride || !isDirectPerplexityBaseUrl(baseUrl) ? "chat_completions" : "search_api",
  };
}

function extractPerplexityCitations(data: PerplexitySearchResponse): string[] {
  const topLevel = (data.citations ?? []).filter((url): url is string =>
    Boolean(normalizeOptionalString(url)),
  );
  if (topLevel.length > 0) {
    return [...new Set(topLevel)];
  }
  const citations: string[] = [];
  for (const choice of data.choices ?? []) {
    for (const annotation of choice.message?.annotations ?? []) {
      if (annotation.type !== "url_citation") {
        continue;
      }
      const url =
        typeof annotation.url_citation?.url === "string"
          ? annotation.url_citation.url
          : typeof annotation.url === "string"
            ? annotation.url
            : undefined;
      const normalizedUrl = normalizeOptionalString(url);
      if (normalizedUrl) {
        citations.push(normalizedUrl);
      }
    }
  }
  return [...new Set(citations)];
}

async function runPerplexitySearchApi(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  country?: string;
  searchDomainFilter?: string[];
  searchRecencyFilter?: string;
  searchLanguageFilter?: string[];
  searchAfterDate?: string;
  searchBeforeDate?: string;
  maxTokens?: number;
  maxTokensPerPage?: number;
}): Promise<Record<string, unknown>[]> {
  const body: Record<string, unknown> = {
    max_results: params.count,
    query: params.query,
  };
  if (params.country) {
    body.country = params.country;
  }
  if (params.searchDomainFilter?.length) {
    body.search_domain_filter = params.searchDomainFilter;
  }
  if (params.searchRecencyFilter) {
    body.search_recency_filter = params.searchRecencyFilter;
  }
  if (params.searchLanguageFilter?.length) {
    body.search_language_filter = params.searchLanguageFilter;
  }
  if (params.searchAfterDate) {
    body.search_after_date = params.searchAfterDate;
  }
  if (params.searchBeforeDate) {
    body.search_before_date = params.searchBeforeDate;
  }
  if (params.maxTokens !== undefined) {
    body.max_tokens = params.maxTokens;
  }
  if (params.maxTokensPerPage !== undefined) {
    body.max_tokens_per_page = params.maxTokensPerPage;
  }

  return withTrustedWebSearchEndpoint(
    {
      init: {
        body: JSON.stringify(body),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Web Search",
        },
        method: "POST",
      },
      timeoutSeconds: params.timeoutSeconds,
      url: PERPLEXITY_SEARCH_ENDPOINT,
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Perplexity Search");
      }
      const data = (await res.json()) as PerplexitySearchApiResponse;
      return (data.results ?? []).map((entry) => ({
        description: entry.snippet ? wrapWebContent(entry.snippet, "web_search") : "",
        published: entry.date ?? undefined,
        siteName: resolveSiteName(entry.url) || undefined,
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url: entry.url ?? "",
      }));
    },
  );
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const endpoint = `${params.baseUrl.trim().replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    messages: [{ content: params.query, role: "user" }],
    model: resolvePerplexityRequestModel(params.baseUrl, params.model),
  };
  if (params.freshness) {
    body.search_recency_filter = params.freshness;
  }

  return withTrustedWebSearchEndpoint(
    {
      init: {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Web Search",
        },
        method: "POST",
      },
      timeoutSeconds: params.timeoutSeconds,
      url: endpoint,
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Perplexity");
      }
      const data = (await res.json()) as PerplexitySearchResponse;
      return {
        citations: extractPerplexityCitations(data),
        content: data.choices?.[0]?.message?.content ?? "No response",
      };
    },
  );
}

function resolveRuntimeTransport(params: {
  searchConfig?: Record<string, unknown>;
  resolvedKey?: string;
  keySource: WebSearchCredentialResolutionSource;
  fallbackEnvVar?: string;
}): PerplexityTransport | undefined {
  const perplexity = params.searchConfig?.perplexity;
  const scoped =
    perplexity && typeof perplexity === "object" && !Array.isArray(perplexity)
      ? (perplexity as { baseUrl?: string; model?: string })
      : undefined;
  const configuredBaseUrl = normalizeOptionalString(scoped?.baseUrl) ?? "";
  const configuredModel = normalizeOptionalString(scoped?.model) ?? "";
  const baseUrl = (() => {
    if (configuredBaseUrl) {
      return configuredBaseUrl;
    }
    if (params.keySource === "env") {
      if (params.fallbackEnvVar === "PERPLEXITY_API_KEY") {
        return PERPLEXITY_DIRECT_BASE_URL;
      }
      if (params.fallbackEnvVar === "OPENROUTER_API_KEY") {
        return DEFAULT_PERPLEXITY_BASE_URL;
      }
    }
    if ((params.keySource === "config" || params.keySource === "secretRef") && params.resolvedKey) {
      return inferPerplexityBaseUrlFromApiKey(params.resolvedKey) === "openrouter"
        ? DEFAULT_PERPLEXITY_BASE_URL
        : PERPLEXITY_DIRECT_BASE_URL;
    }
    return DEFAULT_PERPLEXITY_BASE_URL;
  })();
  return configuredBaseUrl || configuredModel || !isDirectPerplexityBaseUrl(baseUrl)
    ? "chat_completions"
    : "search_api";
}

function createPerplexitySchema(transport?: PerplexityTransport) {
  const querySchema = {
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        maximum: MAX_SEARCH_COUNT,
        minimum: 1,
      }),
    ),
    freshness: Type.Optional(
      Type.String({ description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'." }),
    ),
    query: Type.String({ description: "Search query string." }),
  };
  if (transport === "chat_completions") {
    return Type.Object(querySchema);
  }
  return Type.Object({
    ...querySchema,
    country: Type.Optional(
      Type.String({ description: "Native Perplexity Search API only. 2-letter country code." }),
    ),
    date_after: Type.Optional(
      Type.String({
        description:
          "Native Perplexity Search API only. Only results published after this date (YYYY-MM-DD).",
      }),
    ),
    date_before: Type.Optional(
      Type.String({
        description:
          "Native Perplexity Search API only. Only results published before this date (YYYY-MM-DD).",
      }),
    ),
    domain_filter: Type.Optional(
      Type.Array(Type.String(), {
        description: "Native Perplexity Search API only. Domain filter (max 20).",
      }),
    ),
    language: Type.Optional(
      Type.String({ description: "Native Perplexity Search API only. ISO 639-1 language code." }),
    ),
    max_tokens: Type.Optional(
      Type.Number({
        description: "Native Perplexity Search API only. Total content budget across all results.",
        maximum: 1000000,
        minimum: 1,
      }),
    ),
    max_tokens_per_page: Type.Optional(
      Type.Number({
        description: "Native Perplexity Search API only. Max tokens extracted per page.",
        minimum: 1,
      }),
    ),
  });
}

function createPerplexityToolDefinition(
  searchConfig?: SearchConfigRecord,
  runtimeTransport?: PerplexityTransport,
): WebSearchProviderToolDefinition {
  const perplexityConfig = resolvePerplexityConfig(searchConfig);
  const schemaTransport =
    runtimeTransport ??
    (perplexityConfig.baseUrl || perplexityConfig.model ? "chat_completions" : undefined);

  return {
    description:
      schemaTransport === "chat_completions"
        ? "Search the web using Perplexity Sonar via Perplexity/OpenRouter chat completions. Returns AI-synthesized answers with citations from web-grounded search."
        : "Search the web using Perplexity. Runtime routing decides between native Search API and Sonar chat-completions compatibility. Structured filters are available on the native Search API path.",
    execute: async (args) => {
      const runtime = resolvePerplexityTransport(perplexityConfig);
      if (!runtime.apiKey) {
        return {
          docs: "https://docs.openclaw.ai/tools/web",
          error: "missing_perplexity_api_key",
          message:
            "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
        };
      }

      const params = args;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const rawFreshness = readStringParam(params, "freshness");
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "perplexity") : undefined;
      if (rawFreshness && !freshness) {
        return {
          docs: "https://docs.openclaw.ai/tools/web",
          error: "invalid_freshness",
          message: "freshness must be day, week, month, or year.",
        };
      }

      const structured = runtime.transport === "search_api";
      const country = readStringParam(params, "country");
      const language = readStringParam(params, "language");
      const rawDateAfter = readStringParam(params, "date_after");
      const rawDateBefore = readStringParam(params, "date_before");
      const domainFilter = readStringArrayParam(params, "domain_filter");
      const maxTokens = readNumberParam(params, "max_tokens", { integer: true });
      const maxTokensPerPage = readNumberParam(params, "max_tokens_per_page", { integer: true });

      if (!structured) {
        if (country) {
          return {
            docs: "https://docs.openclaw.ai/tools/web",
            error: "unsupported_country",
            message:
              "country filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
          };
        }
        if (language) {
          return {
            docs: "https://docs.openclaw.ai/tools/web",
            error: "unsupported_language",
            message:
              "language filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
          };
        }
        if (rawDateAfter || rawDateBefore) {
          return {
            docs: "https://docs.openclaw.ai/tools/web",
            error: "unsupported_date_filter",
            message:
              "date_after/date_before are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
          };
        }
        if (domainFilter?.length) {
          return {
            docs: "https://docs.openclaw.ai/tools/web",
            error: "unsupported_domain_filter",
            message:
              "domain_filter is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
          };
        }
        if (maxTokens !== undefined || maxTokensPerPage !== undefined) {
          return {
            docs: "https://docs.openclaw.ai/tools/web",
            error: "unsupported_content_budget",
            message:
              "max_tokens and max_tokens_per_page are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
          };
        }
      }

      if (language && !/^[a-z]{2}$/i.test(language)) {
        return {
          docs: "https://docs.openclaw.ai/tools/web",
          error: "invalid_language",
          message: "language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'.",
        };
      }
      if (rawFreshness && (rawDateAfter || rawDateBefore)) {
        return {
          docs: "https://docs.openclaw.ai/tools/web",
          error: "conflicting_time_filters",
          message:
            "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
        };
      }
      const dateAfter = rawDateAfter ? normalizeToIsoDate(rawDateAfter) : undefined;
      const dateBefore = rawDateBefore ? normalizeToIsoDate(rawDateBefore) : undefined;
      if (rawDateAfter && !dateAfter) {
        return {
          docs: "https://docs.openclaw.ai/tools/web",
          error: "invalid_date",
          message: "date_after must be YYYY-MM-DD format.",
        };
      }
      if (rawDateBefore && !dateBefore) {
        return {
          docs: "https://docs.openclaw.ai/tools/web",
          error: "invalid_date",
          message: "date_before must be YYYY-MM-DD format.",
        };
      }
      if (dateAfter && dateBefore && dateAfter > dateBefore) {
        return {
          docs: "https://docs.openclaw.ai/tools/web",
          error: "invalid_date_range",
          message: "date_after must be before date_before.",
        };
      }
      if (domainFilter?.length) {
        const hasDeny = domainFilter.some((entry) => entry.startsWith("-"));
        const hasAllow = domainFilter.some((entry) => !entry.startsWith("-"));
        if (hasDeny && hasAllow) {
          return {
            docs: "https://docs.openclaw.ai/tools/web",
            error: "invalid_domain_filter",
            message:
              "domain_filter cannot mix allowlist and denylist entries. Use either all positive entries (allowlist) or all entries prefixed with '-' (denylist).",
          };
        }
        if (domainFilter.length > 20) {
          return {
            docs: "https://docs.openclaw.ai/tools/web",
            error: "invalid_domain_filter",
            message: "domain_filter supports a maximum of 20 domains.",
          };
        }
      }

      const cacheKey = buildSearchCacheKey([
        "perplexity",
        runtime.transport,
        runtime.baseUrl,
        runtime.model,
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        country,
        language,
        freshness,
        dateAfter,
        dateBefore,
        domainFilter?.join(","),
        maxTokens,
        maxTokensPerPage,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const payload =
        runtime.transport === "chat_completions"
          ? {
              externalContent: {
                provider: "perplexity",
                source: "web_search",
                untrusted: true,
                wrapped: true,
              },
              model: runtime.model,
              provider: "perplexity",
              query,
              tookMs: Date.now() - start,
              ...(await (async () => {
                const result = await runPerplexitySearch({
                  apiKey: runtime.apiKey!,
                  baseUrl: runtime.baseUrl,
                  freshness,
                  model: runtime.model,
                  query,
                  timeoutSeconds,
                });
                return {
                  citations: result.citations,
                  content: wrapWebContent(result.content, "web_search"),
                };
              })()),
            }
          : {
              count: 0,
              externalContent: {
                provider: "perplexity",
                source: "web_search",
                untrusted: true,
                wrapped: true,
              },
              provider: "perplexity",
              query,
              results: await runPerplexitySearchApi({
                query,
                apiKey: runtime.apiKey,
                count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
                timeoutSeconds,
                country: country ?? undefined,
                searchDomainFilter: domainFilter,
                searchRecencyFilter: freshness,
                searchLanguageFilter: language ? [language] : undefined,
                searchAfterDate: dateAfter ? isoToPerplexityDate(dateAfter) : undefined,
                searchBeforeDate: dateBefore ? isoToPerplexityDate(dateBefore) : undefined,
                maxTokens: maxTokens ?? undefined,
                maxTokensPerPage: maxTokensPerPage ?? undefined,
              }),
              tookMs: Date.now() - start,
            };

      if (Array.isArray((payload as { results?: unknown[] }).results)) {
        (payload as { count: number }).count = (payload as { results: unknown[] }).results.length;
        (payload as { tookMs: number }).tookMs = Date.now() - start;
      } else {
        (payload as { tookMs: number }).tookMs = Date.now() - start;
      }

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
    parameters: createPerplexitySchema(schemaTransport),
  };
}

export function createPerplexityWebSearchProvider(): WebSearchProviderPlugin {
  return {
    autoDetectOrder: 50,
    createTool: (ctx) =>
      createPerplexityToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "perplexity",
          resolveProviderWebSearchPluginConfig(ctx.config, "perplexity"),
        ),
        ctx.runtimeMetadata?.perplexityTransport,
      ),
    credentialLabel: "Perplexity API key",
    credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
    docsUrl: "https://docs.openclaw.ai/perplexity",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "perplexity")?.apiKey,
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "perplexity"),
    hint: "Requires Perplexity API key or OpenRouter API key · structured results",
    id: "perplexity",
    inactiveSecretPaths: ["plugins.entries.perplexity.config.webSearch.apiKey"],
    label: "Perplexity Search",
    onboardingScopes: ["text-inference"],
    placeholder: "pplx-...",
    resolveRuntimeMetadata: (ctx) => ({
      perplexityTransport: resolveRuntimeTransport({
        fallbackEnvVar: ctx.resolvedCredential?.fallbackEnvVar,
        keySource: ctx.resolvedCredential?.source ?? "missing",
        resolvedKey: ctx.resolvedCredential?.value,
        searchConfig: mergeScopedSearchConfig(
          ctx.searchConfig,
          "perplexity",
          resolveProviderWebSearchPluginConfig(ctx.config, "perplexity"),
        ),
      }),
    }),
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "perplexity", "apiKey", value);
    },
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "perplexity", value),
    signupUrl: "https://www.perplexity.ai/settings/api",
  };
}

export const __testing = {
  inferPerplexityBaseUrlFromApiKey,
  isDirectPerplexityBaseUrl,
  isoToPerplexityDate,
  normalizeToIsoDate,
  resolvePerplexityApiKey,
  resolvePerplexityBaseUrl,
  resolvePerplexityModel,
  resolvePerplexityRequestModel,
  resolvePerplexityTransport,
} as const;
