import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { runFirecrawlScrape } from "./firecrawl-client.js";

function optionalStringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Optional(
    Type.Unsafe<T[number]>({
      enum: [...values],
      type: "string",
      ...options,
    }),
  );
}

const FirecrawlScrapeToolSchema = Type.Object(
  {
    extractMode: optionalStringEnum(["markdown", "text"] as const, {
      description: 'Extraction mode ("markdown" or "text"). Default: markdown.',
    }),
    maxAgeMs: Type.Optional(
      Type.Number({
        description: "Maximum Firecrawl cache age in milliseconds.",
        minimum: 0,
      }),
    ),
    maxChars: Type.Optional(
      Type.Number({
        description: "Maximum characters to return.",
        minimum: 100,
      }),
    ),
    onlyMainContent: Type.Optional(
      Type.Boolean({
        description: "Keep only main content when Firecrawl supports it.",
      }),
    ),
    proxy: optionalStringEnum(["auto", "basic", "stealth"] as const, {
      description: 'Firecrawl proxy mode ("auto", "basic", or "stealth").',
    }),
    storeInCache: Type.Optional(
      Type.Boolean({
        description: "Whether Firecrawl should store the scrape in its cache.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for the Firecrawl scrape request.",
        minimum: 1,
      }),
    ),
    url: Type.String({ description: "HTTP or HTTPS URL to scrape via Firecrawl." }),
  },
  { additionalProperties: false },
);

export function createFirecrawlScrapeTool(api: OpenClawPluginApi) {
  return {
    description:
      "Scrape a page using Firecrawl v2/scrape. Useful for JS-heavy or bot-protected pages where plain web_fetch is weak.",
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const url = readStringParam(rawParams, "url", { required: true });
      const extractMode =
        readStringParam(rawParams, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readNumberParam(rawParams, "maxChars", { integer: true });
      const maxAgeMs = readNumberParam(rawParams, "maxAgeMs", { integer: true });
      const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", {
        integer: true,
      });
      const proxyRaw = readStringParam(rawParams, "proxy");
      const proxy =
        proxyRaw === "basic" || proxyRaw === "stealth" || proxyRaw === "auto"
          ? proxyRaw
          : undefined;
      const onlyMainContent =
        typeof rawParams.onlyMainContent === "boolean" ? rawParams.onlyMainContent : undefined;
      const storeInCache =
        typeof rawParams.storeInCache === "boolean" ? rawParams.storeInCache : undefined;

      return jsonResult(
        await runFirecrawlScrape({
          cfg: api.config,
          extractMode,
          maxAgeMs,
          maxChars,
          onlyMainContent,
          proxy,
          storeInCache,
          timeoutSeconds,
          url,
        }),
      );
    },
    label: "Firecrawl Scrape",
    name: "firecrawl_scrape",
    parameters: FirecrawlScrapeToolSchema,
  };
}
