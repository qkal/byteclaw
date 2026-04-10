import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  postTrustedWebToolsJson,
  readCache,
  resolveCacheTtlMs,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import {
  DEFAULT_TAVILY_BASE_URL,
  resolveTavilyApiKey,
  resolveTavilyBaseUrl,
  resolveTavilyExtractTimeoutSeconds,
  resolveTavilySearchTimeoutSeconds,
} from "./config.js";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const EXTRACT_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const DEFAULT_SEARCH_COUNT = 5;

export interface TavilySearchParams {
  cfg?: OpenClawConfig;
  query: string;
  searchDepth?: string;
  topic?: string;
  maxResults?: number;
  includeAnswer?: boolean;
  timeRange?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  timeoutSeconds?: number;
}

export interface TavilyExtractParams {
  cfg?: OpenClawConfig;
  urls: string[];
  query?: string;
  extractDepth?: string;
  chunksPerSource?: number;
  includeImages?: boolean;
  timeoutSeconds?: number;
}

function resolveEndpoint(baseUrl: string, pathname: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return `${DEFAULT_TAVILY_BASE_URL}${pathname}`;
  }
  try {
    const url = new URL(trimmed);
    // Always append the endpoint pathname to the base URL path,
    // Supporting both bare hosts and reverse-proxy path prefixes.
    url.pathname = url.pathname.replace(/\/$/, "") + pathname;
    return url.toString();
  } catch {
    return `${DEFAULT_TAVILY_BASE_URL}${pathname}`;
  }
}

export async function runTavilySearch(
  params: TavilySearchParams,
): Promise<Record<string, unknown>> {
  const apiKey = resolveTavilyApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "web_search (tavily) needs a Tavily API key. Set TAVILY_API_KEY in the Gateway environment, or configure plugins.entries.tavily.config.webSearch.apiKey.",
    );
  }
  const count =
    typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
      ? Math.max(1, Math.min(20, Math.floor(params.maxResults)))
      : DEFAULT_SEARCH_COUNT;
  const timeoutSeconds = resolveTavilySearchTimeoutSeconds(params.timeoutSeconds);
  const baseUrl = resolveTavilyBaseUrl(params.cfg);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      baseUrl,
      count,
      excludeDomains: params.excludeDomains,
      includeAnswer: params.includeAnswer,
      includeDomains: params.includeDomains,
      q: params.query,
      searchDepth: params.searchDepth,
      timeRange: params.timeRange,
      topic: params.topic,
      type: "tavily-search",
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const body: Record<string, unknown> = {
    max_results: count,
    query: params.query,
  };
  if (params.searchDepth) {
    body.search_depth = params.searchDepth;
  }
  if (params.topic) {
    body.topic = params.topic;
  }
  if (params.includeAnswer) {
    body.include_answer = true;
  }
  if (params.timeRange) {
    body.time_range = params.timeRange;
  }
  if (params.includeDomains?.length) {
    body.include_domains = params.includeDomains;
  }
  if (params.excludeDomains?.length) {
    body.exclude_domains = params.excludeDomains;
  }

  const start = Date.now();
  const payload = await postTrustedWebToolsJson(
    {
      apiKey,
      body,
      errorLabel: "Tavily Search",
      extraHeaders: { "X-Client-Source": "openclaw" },
      timeoutSeconds,
      url: resolveEndpoint(baseUrl, "/search"),
    },
    async (response) => (await response.json()) as Record<string, unknown>,
  );

  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results = rawResults.map((r: Record<string, unknown>) =>
    Object.assign(
      {
        title: typeof r.title === `string` ? wrapWebContent(r.title, `web_search`) : ``,
        url: typeof r.url === `string` ? r.url : ``,
        snippet: typeof r.content === `string` ? wrapWebContent(r.content, `web_search`) : ``,
        score: typeof r.score === `number` ? r.score : undefined,
      },
      typeof r.published_date === `string` ? { published: r.published_date } : {},
    ),
  );

  const result: Record<string, unknown> = {
    count: results.length,
    externalContent: {
      provider: "tavily",
      source: "web_search",
      untrusted: true,
      wrapped: true,
    },
    provider: "tavily",
    query: params.query,
    results,
    tookMs: Date.now() - start,
  };
  if (typeof payload.answer === "string" && payload.answer) {
    result.answer = wrapWebContent(payload.answer, "web_search");
  }

  writeCache(
    SEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export async function runTavilyExtract(
  params: TavilyExtractParams,
): Promise<Record<string, unknown>> {
  const apiKey = resolveTavilyApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "tavily_extract needs a Tavily API key. Set TAVILY_API_KEY in the Gateway environment, or configure plugins.entries.tavily.config.webSearch.apiKey.",
    );
  }
  const baseUrl = resolveTavilyBaseUrl(params.cfg);
  const timeoutSeconds = resolveTavilyExtractTimeoutSeconds(params.timeoutSeconds);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      baseUrl,
      chunksPerSource: params.chunksPerSource,
      extractDepth: params.extractDepth,
      includeImages: params.includeImages,
      query: params.query,
      type: "tavily-extract",
      urls: params.urls,
    }),
  );
  const cached = readCache(EXTRACT_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const body: Record<string, unknown> = { urls: params.urls };
  if (params.query) {
    body.query = params.query;
  }
  if (params.extractDepth) {
    body.extract_depth = params.extractDepth;
  }
  if (params.chunksPerSource) {
    body.chunks_per_source = params.chunksPerSource;
  }
  if (params.includeImages) {
    body.include_images = true;
  }

  const start = Date.now();
  const payload = await postTrustedWebToolsJson(
    {
      apiKey,
      body,
      errorLabel: "Tavily Extract",
      extraHeaders: { "X-Client-Source": "openclaw" },
      timeoutSeconds,
      url: resolveEndpoint(baseUrl, "/extract"),
    },
    async (response) => (await response.json()) as Record<string, unknown>,
  );

  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results = rawResults.map((r: Record<string, unknown>) =>
    Object.assign(
      {
        url: typeof r.url === `string` ? r.url : ``,
        rawContent:
          typeof r.raw_content === `string`
            ? wrapExternalContent(r.raw_content, { source: `web_fetch`, includeWarning: false })
            : ``,
      },
      typeof r.content === `string`
        ? {
            content: wrapExternalContent(r.content, { source: `web_fetch`, includeWarning: false }),
          }
        : {},
      Array.isArray(r.images)
        ? {
            images: (r.images as string[]).map((img) =>
              wrapExternalContent(String(img), { source: `web_fetch`, includeWarning: false }),
            ),
          }
        : {},
    ),
  );

  const failedResults = Array.isArray(payload.failed_results) ? payload.failed_results : [];

  const result: Record<string, unknown> = {
    count: results.length,
    externalContent: {
      provider: "tavily",
      source: "web_fetch",
      untrusted: true,
      wrapped: true,
    },
    provider: "tavily",
    results,
    tookMs: Date.now() - start,
    ...(failedResults.length > 0 ? { failedResults } : {}),
  };

  writeCache(
    EXTRACT_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export const __testing = {
  resolveEndpoint,
};
