import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  DEFAULT_SEARCH_COUNT,
  buildSearchCacheKey,
  formatCliCommand,
  normalizeFreshness,
  parseIsoDateRange,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  type BraveLlmContextResponse,
  mapBraveLlmContextResults,
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
  resolveBraveConfig,
  resolveBraveMode,
} from "./brave-web-search-provider.shared.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

function resolveBraveApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["BRAVE_API_KEY"])
  );
}

function missingBraveKeyPayload() {
  return {
    docs: "https://docs.openclaw.ai/tools/web",
    error: "missing_brave_api_key",
    message: `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
  };
}

async function runBraveLlmContextSearch(params: {
  query: string;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  freshness?: string;
}): Promise<{
  results: {
    url: string;
    title: string;
    snippets: string[];
    siteName?: string;
  }[];
  sources?: BraveLlmContextResponse["sources"];
}> {
  const url = new URL(BRAVE_LLM_CONTEXT_ENDPOINT);
  url.searchParams.set("q", params.query);
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  return withTrustedWebSearchEndpoint(
    {
      init: {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
        method: "GET",
      },
      timeoutSeconds: params.timeoutSeconds,
      url: url.toString(),
    },
    async (response) => {
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Brave LLM Context API error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const data = (await response.json()) as BraveLlmContextResponse;
      return { results: mapBraveLlmContextResults(data), sources: data.sources };
    },
  );
}

async function runBraveWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
}): Promise<Record<string, unknown>[]> {
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
  } else if (params.dateAfter) {
    url.searchParams.set(
      "freshness",
      `${params.dateAfter}to${new Date().toISOString().slice(0, 10)}`,
    );
  } else if (params.dateBefore) {
    url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
  }

  return withTrustedWebSearchEndpoint(
    {
      init: {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
        method: "GET",
      },
      timeoutSeconds: params.timeoutSeconds,
      url: url.toString(),
    },
    async (response) => {
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Brave Search API error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const data = (await response.json()) as BraveSearchResponse;
      const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
      return results.map((entry) => {
        const description = entry.description ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        return {
          description: description ? wrapWebContent(description, "web_search") : "",
          published: entry.age || undefined,
          siteName: resolveSiteName(url) || undefined,
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
        };
      });
    },
  );
}

export async function executeBraveSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
): Promise<Record<string, unknown>> {
  const apiKey = resolveBraveApiKey(searchConfig);
  if (!apiKey) {
    return missingBraveKeyPayload();
  }

  const braveConfig = resolveBraveConfig(searchConfig);
  const braveMode = resolveBraveMode(braveConfig);
  const query = readStringParam(args, "query", { required: true });
  const count =
    readNumberParam(args, "count", { integer: true }) ?? searchConfig?.maxResults ?? undefined;
  const country = normalizeBraveCountry(readStringParam(args, "country"));
  const language = readStringParam(args, "language");
  const search_lang = readStringParam(args, "search_lang");
  const ui_lang = readStringParam(args, "ui_lang");
  const normalizedLanguage = normalizeBraveLanguageParams({
    search_lang: search_lang || language,
    ui_lang,
  });

  if (normalizedLanguage.invalidField === "search_lang") {
    return {
      docs: "https://docs.openclaw.ai/tools/web",
      error: "invalid_search_lang",
      message:
        "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
    };
  }
  if (normalizedLanguage.invalidField === "ui_lang") {
    return {
      docs: "https://docs.openclaw.ai/tools/web",
      error: "invalid_ui_lang",
      message: "ui_lang must be a language-region locale like 'en-US'.",
    };
  }
  if (normalizedLanguage.ui_lang && braveMode === "llm-context") {
    return {
      docs: "https://docs.openclaw.ai/tools/web",
      error: "unsupported_ui_lang",
      message:
        "ui_lang is not supported by Brave llm-context mode. Remove ui_lang or use Brave web mode for locale-based UI hints.",
    };
  }

  const rawFreshness = readStringParam(args, "freshness");
  if (rawFreshness && braveMode === "llm-context") {
    return {
      docs: "https://docs.openclaw.ai/tools/web",
      error: "unsupported_freshness",
      message:
        "freshness filtering is not supported by Brave llm-context mode. Remove freshness or use Brave web mode.",
    };
  }
  const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "brave") : undefined;
  if (rawFreshness && !freshness) {
    return {
      docs: "https://docs.openclaw.ai/tools/web",
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
    };
  }

  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  if (rawFreshness && (rawDateAfter || rawDateBefore)) {
    return {
      docs: "https://docs.openclaw.ai/tools/web",
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
    };
  }
  if ((rawDateAfter || rawDateBefore) && braveMode === "llm-context") {
    return {
      docs: "https://docs.openclaw.ai/tools/web",
      error: "unsupported_date_filter",
      message:
        "date_after/date_before filtering is not supported by Brave llm-context mode. Use Brave web mode for date filters.",
    };
  }

  const parsedDateRange = parseIsoDateRange({
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
    rawDateAfter,
    rawDateBefore,
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }

  const { dateAfter, dateBefore } = parsedDateRange;
  const cacheKey = buildSearchCacheKey([
    "brave",
    braveMode,
    query,
    resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    country,
    normalizedLanguage.search_lang,
    normalizedLanguage.ui_lang,
    freshness,
    dateAfter,
    dateBefore,
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

  if (braveMode === "llm-context") {
    const { results, sources } = await runBraveLlmContextSearch({
      apiKey,
      country: country ?? undefined,
      freshness,
      query,
      search_lang: normalizedLanguage.search_lang,
      timeoutSeconds,
    });
    const payload = {
      count: results.length,
      externalContent: {
        provider: "brave",
        source: "web_search",
        untrusted: true,
        wrapped: true,
      },
      mode: "llm-context" as const,
      provider: "brave",
      query,
      results: results.map((entry) => ({
        siteName: entry.siteName,
        snippets: entry.snippets.map((snippet) => wrapWebContent(snippet, "web_search")),
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url: entry.url,
      })),
      sources,
      tookMs: Date.now() - start,
    };
    writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
    return payload;
  }

  const results = await runBraveWebSearch({
    apiKey,
    count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    country: country ?? undefined,
    dateAfter,
    dateBefore,
    freshness,
    query,
    search_lang: normalizedLanguage.search_lang,
    timeoutSeconds,
    ui_lang: normalizedLanguage.ui_lang,
  });
  const payload = {
    count: results.length,
    externalContent: {
      provider: "brave",
      source: "web_search",
      untrusted: true,
      wrapped: true,
    },
    provider: "brave",
    query,
    results,
    tookMs: Date.now() - start,
  };
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
