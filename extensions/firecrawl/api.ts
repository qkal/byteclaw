import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { runFirecrawlScrape } from "./src/firecrawl-client.js";

export interface FetchFirecrawlContentParams {
  url: string;
  extractMode: "markdown" | "text";
  apiKey: string;
  baseUrl: string;
  onlyMainContent: boolean;
  maxAgeMs: number;
  proxy: "auto" | "basic" | "stealth";
  storeInCache: boolean;
  timeoutSeconds: number;
  maxChars?: number;
}

export interface FetchFirecrawlContentResult {
  text: string;
  title?: string;
  finalUrl?: string;
  status?: number;
  warning?: string;
}

export async function fetchFirecrawlContent(
  params: FetchFirecrawlContentParams,
): Promise<FetchFirecrawlContentResult> {
  const cfg: OpenClawConfig = {
    plugins: {
      entries: {
        firecrawl: {
          config: {
            webFetch: {
              apiKey: params.apiKey,
              baseUrl: params.baseUrl,
              maxAgeMs: params.maxAgeMs,
              onlyMainContent: params.onlyMainContent,
              timeoutSeconds: params.timeoutSeconds,
            },
          },
          enabled: true,
        },
      },
    },
  };

  const result = await runFirecrawlScrape({
    cfg,
    extractMode: params.extractMode,
    maxAgeMs: params.maxAgeMs,
    maxChars: params.maxChars,
    onlyMainContent: params.onlyMainContent,
    proxy: params.proxy,
    storeInCache: params.storeInCache,
    timeoutSeconds: params.timeoutSeconds,
    url: params.url,
  });

  return {
    finalUrl: readStringValue(result.finalUrl),
    status: typeof result.status === "number" ? result.status : undefined,
    text: typeof result.text === "string" ? result.text : "",
    title: readStringValue(result.title),
    warning: readStringValue(result.warning),
  };
}
