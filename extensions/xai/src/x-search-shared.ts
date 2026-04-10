import { postTrustedWebToolsJson, wrapWebContent } from "@openclaw/plugin-sdk/provider-web-search";
import {
  XAI_RESPONSES_ENDPOINT,
  buildXaiResponsesToolBody,
  resolveXaiResponseTextCitationsAndInline,
} from "./responses-tool-shared.js";
import {
  coerceXaiToolConfig,
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./tool-config-shared.js";
import type { XaiWebSearchResponse } from "./web-search-shared.js";

export const XAI_X_SEARCH_ENDPOINT = XAI_RESPONSES_ENDPOINT;
export const XAI_DEFAULT_X_SEARCH_MODEL = "grok-4-1-fast-non-reasoning";

export interface XaiXSearchConfig {
  apiKey?: unknown;
  model?: unknown;
  inlineCitations?: unknown;
  maxTurns?: unknown;
}

export interface XaiXSearchOptions {
  query: string;
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  fromDate?: string;
  toDate?: string;
  enableImageUnderstanding?: boolean;
  enableVideoUnderstanding?: boolean;
}

export interface XaiXSearchResult {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
}

export function resolveXaiXSearchConfig(config?: Record<string, unknown>): XaiXSearchConfig {
  return coerceXaiToolConfig<XaiXSearchConfig>(config);
}

export function resolveXaiXSearchModel(config?: Record<string, unknown>): string {
  return resolveNormalizedXaiToolModel({
    config,
    defaultModel: XAI_DEFAULT_X_SEARCH_MODEL,
  });
}

export function resolveXaiXSearchInlineCitations(config?: Record<string, unknown>): boolean {
  return resolveXaiXSearchConfig(config).inlineCitations === true;
}

export function resolveXaiXSearchMaxTurns(config?: Record<string, unknown>): number | undefined {
  return resolvePositiveIntegerToolConfig(config, "maxTurns");
}

function buildXSearchTool(options: XaiXSearchOptions): Record<string, unknown> {
  return {
    type: "x_search",
    ...(options.allowedXHandles?.length ? { allowed_x_handles: options.allowedXHandles } : {}),
    ...(options.excludedXHandles?.length ? { excluded_x_handles: options.excludedXHandles } : {}),
    ...(options.fromDate ? { from_date: options.fromDate } : {}),
    ...(options.toDate ? { to_date: options.toDate } : {}),
    ...(options.enableImageUnderstanding ? { enable_image_understanding: true } : {}),
    ...(options.enableVideoUnderstanding ? { enable_video_understanding: true } : {}),
  };
}

export function buildXaiXSearchPayload(params: {
  query: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
  options?: XaiXSearchOptions;
}): Record<string, unknown> {
  return {
    citations: params.citations,
    content: wrapWebContent(params.content, "web_search"),
    externalContent: {
      provider: "xai",
      source: "x_search",
      untrusted: true,
      wrapped: true,
    },
    model: params.model,
    provider: "xai",
    query: params.query,
    tookMs: params.tookMs,
    ...(params.inlineCitations ? { inlineCitations: params.inlineCitations } : {}),
    ...(params.options?.allowedXHandles?.length
      ? { allowedXHandles: params.options.allowedXHandles }
      : {}),
    ...(params.options?.excludedXHandles?.length
      ? { excludedXHandles: params.options.excludedXHandles }
      : {}),
    ...(params.options?.fromDate ? { fromDate: params.options.fromDate } : {}),
    ...(params.options?.toDate ? { toDate: params.options.toDate } : {}),
    ...(params.options?.enableImageUnderstanding ? { enableImageUnderstanding: true } : {}),
    ...(params.options?.enableVideoUnderstanding ? { enableVideoUnderstanding: true } : {}),
  };
}

export async function requestXaiXSearch(params: {
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  maxTurns?: number;
  options: XaiXSearchOptions;
}): Promise<XaiXSearchResult> {
  return await postTrustedWebToolsJson(
    {
      apiKey: params.apiKey,
      body: buildXaiResponsesToolBody({
        inputText: params.options.query,
        maxTurns: params.maxTurns,
        model: params.model,
        tools: [buildXSearchTool(params.options)],
      }),
      errorLabel: "xAI",
      timeoutSeconds: params.timeoutSeconds,
      url: XAI_X_SEARCH_ENDPOINT,
    },
    async (response) => {
      const data = (await response.json()) as XaiWebSearchResponse;
      return resolveXaiResponseTextCitationsAndInline(data, params.inlineCitations);
    },
  );
}

export const __testing = {
  XAI_DEFAULT_X_SEARCH_MODEL,
  buildXSearchTool,
  buildXaiXSearchPayload,
  requestXaiXSearch,
  resolveXaiXSearchConfig,
  resolveXaiXSearchInlineCitations,
  resolveXaiXSearchMaxTurns,
  resolveXaiXSearchModel,
} as const;
