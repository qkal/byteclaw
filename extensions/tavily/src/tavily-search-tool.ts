import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { runTavilySearch } from "./tavily-client.js";

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

const TavilySearchToolSchema = Type.Object(
  {
    exclude_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Exclude results from these domains.",
      }),
    ),
    include_answer: Type.Optional(
      Type.Boolean({
        description: "Include an AI-generated answer summary (default: false).",
      }),
    ),
    include_domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Only include results from these domains.",
      }),
    ),
    max_results: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-20).",
        maximum: 20,
        minimum: 1,
      }),
    ),
    query: Type.String({ description: "Search query string." }),
    search_depth: optionalStringEnum(["basic", "advanced"] as const, {
      description: 'Search depth: "basic" (default, faster) or "advanced" (more thorough).',
    }),
    time_range: optionalStringEnum(["day", "week", "month", "year"] as const, {
      description: "Filter results by recency: 'day', 'week', 'month', or 'year'.",
    }),
    topic: optionalStringEnum(["general", "news", "finance"] as const, {
      description: 'Search topic: "general" (default), "news", or "finance".',
    }),
  },
  { additionalProperties: false },
);

export function createTavilySearchTool(api: OpenClawPluginApi) {
  return {
    description:
      "Search the web using Tavily Search API. Supports search depth, topic filtering, domain filters, time ranges, and AI answer summaries.",
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const searchDepth = readStringParam(rawParams, "search_depth") || undefined;
      const topic = readStringParam(rawParams, "topic") || undefined;
      const maxResults = readNumberParam(rawParams, "max_results", { integer: true });
      const includeAnswer = rawParams.include_answer === true;
      const timeRange = readStringParam(rawParams, "time_range") || undefined;
      const includeDomains = Array.isArray(rawParams.include_domains)
        ? (rawParams.include_domains as string[]).filter(Boolean)
        : undefined;
      const excludeDomains = Array.isArray(rawParams.exclude_domains)
        ? (rawParams.exclude_domains as string[]).filter(Boolean)
        : undefined;

      return jsonResult(
        await runTavilySearch({
          cfg: api.config,
          excludeDomains: excludeDomains?.length ? excludeDomains : undefined,
          includeAnswer,
          includeDomains: includeDomains?.length ? includeDomains : undefined,
          maxResults,
          query,
          searchDepth,
          timeRange,
          topic,
        }),
      );
    },
    label: "Tavily Search",
    name: "tavily_search",
    parameters: TavilySearchToolSchema,
  };
}
