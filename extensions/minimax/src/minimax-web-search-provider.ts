import { Type } from "@sinclair/typebox";
import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  buildSearchCacheKey,
  formatCliCommand,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setProviderWebSearchPluginConfigValue,
  setTopLevelCredentialValue,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const MINIMAX_SEARCH_ENDPOINT_GLOBAL = "https://api.minimax.io/v1/coding_plan/search";
const MINIMAX_SEARCH_ENDPOINT_CN = "https://api.minimaxi.com/v1/coding_plan/search";
const MINIMAX_CODING_PLAN_ENV_VARS = ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"] as const;

interface MiniMaxSearchResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

interface MiniMaxRelatedSearch {
  query?: string;
}

interface MiniMaxSearchResponse {
  organic?: MiniMaxSearchResult[];
  related_searches?: MiniMaxRelatedSearch[];
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

function resolveMiniMaxApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue([...MINIMAX_CODING_PLAN_ENV_VARS, "MINIMAX_API_KEY"])
  );
}

function isMiniMaxCnHost(value: string | undefined): boolean {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).hostname.endsWith("minimaxi.com");
  } catch {
    return trimmed.includes("minimaxi.com");
  }
}

function resolveMiniMaxRegion(
  searchConfig?: SearchConfigRecord,
  config?: Record<string, unknown>,
): "cn" | "global" {
  // 1. Explicit region in search config takes priority
  const minimax =
    typeof searchConfig?.minimax === "object" &&
    searchConfig.minimax !== null &&
    !Array.isArray(searchConfig.minimax)
      ? (searchConfig.minimax as Record<string, unknown>)
      : undefined;
  const configuredRegion =
    typeof minimax?.region === "string" ? normalizeOptionalString(minimax.region) : undefined;
  if (configuredRegion) {
    return configuredRegion === "cn" ? "cn" : "global";
  }

  // 2. Infer from the shared MiniMax host override.
  if (isMiniMaxCnHost(process.env.MINIMAX_API_HOST)) {
    return "cn";
  }

  // 3. Infer from model provider base URL (set by CN onboarding)
  const models = config?.models as Record<string, unknown> | undefined;
  const providers = models?.providers as Record<string, unknown> | undefined;
  const minimaxProvider = providers?.minimax as Record<string, unknown> | undefined;
  const portalProvider = providers?.["minimax-portal"] as Record<string, unknown> | undefined;
  const baseUrl = typeof minimaxProvider?.baseUrl === "string" ? minimaxProvider.baseUrl : "";
  const portalBaseUrl = typeof portalProvider?.baseUrl === "string" ? portalProvider.baseUrl : "";
  if (isMiniMaxCnHost(baseUrl) || isMiniMaxCnHost(portalBaseUrl)) {
    return "cn";
  }

  return "global";
}

function resolveMiniMaxEndpoint(
  searchConfig?: SearchConfigRecord,
  config?: Record<string, unknown>,
): string {
  return resolveMiniMaxRegion(searchConfig, config) === "cn"
    ? MINIMAX_SEARCH_ENDPOINT_CN
    : MINIMAX_SEARCH_ENDPOINT_GLOBAL;
}

async function runMiniMaxSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  endpoint: string;
  timeoutSeconds: number;
}): Promise<{
  results: Record<string, unknown>[];
  relatedSearches?: string[];
}> {
  return withTrustedWebSearchEndpoint(
    {
      init: {
        body: JSON.stringify({ q: params.query }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      timeoutSeconds: params.timeoutSeconds,
      url: params.endpoint,
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`MiniMax Search API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as MiniMaxSearchResponse;

      if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
        throw new Error(
          `MiniMax Search API error (${data.base_resp.status_code}): ${data.base_resp.status_msg || "unknown error"}`,
        );
      }

      const organic = Array.isArray(data.organic) ? data.organic : [];
      const results = organic.slice(0, params.count).map((entry) => {
        const title = entry.title ?? "";
        const url = entry.link ?? "";
        const snippet = entry.snippet ?? "";
        return {
          description: snippet ? wrapWebContent(snippet, "web_search") : "",
          published: entry.date || undefined,
          siteName: resolveSiteName(url) || undefined,
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
        };
      });

      const relatedSearches = Array.isArray(data.related_searches)
        ? data.related_searches
            .map((r) => r.query)
            .filter((q): q is string => typeof q === "string" && q.length > 0)
            .map((q) => wrapWebContent(q, "web_search"))
        : undefined;

      return { relatedSearches, results };
    },
  );
}

const MiniMaxSearchSchema = Type.Object({
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      maximum: MAX_SEARCH_COUNT,
      minimum: 1,
    }),
  ),
  query: Type.String({ description: "Search query string." }),
});

function missingMiniMaxKeyPayload() {
  return {
    docs: "https://docs.openclaw.ai/tools/web",
    error: "missing_minimax_api_key",
    message: `web_search (minimax) needs a MiniMax Coding Plan key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set MINIMAX_CODE_PLAN_KEY, MINIMAX_CODING_API_KEY, or MINIMAX_API_KEY in the Gateway environment.`,
  };
}

function createMiniMaxToolDefinition(
  searchConfig?: SearchConfigRecord,
  config?: Record<string, unknown>,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using MiniMax Search API. Returns titles, URLs, snippets, and related search suggestions.",
    execute: async (args) => {
      const apiKey = resolveMiniMaxApiKey(searchConfig);
      if (!apiKey) {
        return missingMiniMaxKeyPayload();
      }

      const params = args;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;

      const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
      const endpoint = resolveMiniMaxEndpoint(searchConfig, config);

      const cacheKey = buildSearchCacheKey(["minimax", endpoint, query, resolvedCount]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

      const { results, relatedSearches } = await runMiniMaxSearch({
        apiKey,
        count: resolvedCount,
        endpoint,
        query,
        timeoutSeconds,
      });

      const payload: Record<string, unknown> = {
        count: results.length,
        externalContent: {
          provider: "minimax",
          source: "web_search",
          untrusted: true,
          wrapped: true,
        },
        provider: "minimax",
        query,
        results,
        tookMs: Date.now() - start,
      };

      if (relatedSearches && relatedSearches.length > 0) {
        payload.relatedSearches = relatedSearches;
      }

      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return payload;
    },
    parameters: MiniMaxSearchSchema,
  };
}

export const __testing = {
  MINIMAX_SEARCH_ENDPOINT_CN,
  MINIMAX_SEARCH_ENDPOINT_GLOBAL,
  resolveMiniMaxApiKey,
  resolveMiniMaxEndpoint,
  resolveMiniMaxRegion,
} as const;

export function createMiniMaxWebSearchProvider(): WebSearchProviderPlugin {
  return {
    autoDetectOrder: 15,
    createTool: (ctx) =>
      createMiniMaxToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "minimax",
          resolveProviderWebSearchPluginConfig(ctx.config, "minimax"),
          { mirrorApiKeyToTopLevel: true },
        ) as SearchConfigRecord | undefined,
        ctx.config as Record<string, unknown> | undefined,
      ),
    credentialLabel: "MiniMax Coding Plan key",
    credentialPath: "plugins.entries.minimax.config.webSearch.apiKey",
    docsUrl: "https://docs.openclaw.ai/tools/minimax-search",
    envVars: [...MINIMAX_CODING_PLAN_ENV_VARS],
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "minimax")?.apiKey,
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    hint: "Structured results via MiniMax Coding Plan search API",
    id: "minimax",
    inactiveSecretPaths: ["plugins.entries.minimax.config.webSearch.apiKey"],
    label: "MiniMax Search",
    placeholder: "sk-cp-...",
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "minimax", "apiKey", value);
    },
    setCredentialValue: setTopLevelCredentialValue,
    signupUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
  };
}
