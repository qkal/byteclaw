import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { runFirecrawlSearch } from "./firecrawl-client.js";

const FirecrawlSearchToolSchema = Type.Object(
  {
    categories: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional Firecrawl categories, for example ["github"] or ["research"].',
      }),
    ),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        maximum: 10,
        minimum: 1,
      }),
    ),
    query: Type.String({ description: "Search query string." }),
    scrapeResults: Type.Optional(
      Type.Boolean({
        description: "Include scraped result content when Firecrawl returns it.",
      }),
    ),
    sources: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Optional sources list, for example ["web"], ["news"], or ["images"].',
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for the Firecrawl Search request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createFirecrawlSearchTool(api: OpenClawPluginApi) {
  return {
    description:
      "Search the web using Firecrawl v2/search. Can optionally include scraped content from result pages.",
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const count = readNumberParam(rawParams, "count", { integer: true });
      const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", {
        integer: true,
      });
      const sources = readStringArrayParam(rawParams, "sources");
      const categories = readStringArrayParam(rawParams, "categories");
      const scrapeResults = rawParams.scrapeResults === true;

      return jsonResult(
        await runFirecrawlSearch({
          categories,
          cfg: api.config,
          count,
          query,
          scrapeResults,
          sources,
          timeoutSeconds,
        }),
      );
    },
    label: "Firecrawl Search",
    name: "firecrawl_search",
    parameters: FirecrawlSearchToolSchema,
  };
}
