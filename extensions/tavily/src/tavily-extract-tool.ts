import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { runTavilyExtract } from "./tavily-client.js";

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

const TavilyExtractToolSchema = Type.Object(
  {
    chunks_per_source: Type.Optional(
      Type.Number({
        description: "Chunks per URL (1-5, requires query).",
        maximum: 5,
        minimum: 1,
      }),
    ),
    extract_depth: optionalStringEnum(["basic", "advanced"] as const, {
      description: '"basic" (default) or "advanced" (for JS-heavy pages).',
    }),
    include_images: Type.Optional(
      Type.Boolean({
        description: "Include image URLs in extraction results.",
      }),
    ),
    query: Type.Optional(
      Type.String({
        description: "Rerank extracted chunks by relevance to this query.",
      }),
    ),
    urls: Type.Array(Type.String(), {
      description: "One or more URLs to extract content from (max 20).",
      maxItems: 20,
      minItems: 1,
    }),
  },
  { additionalProperties: false },
);

export function createTavilyExtractTool(api: OpenClawPluginApi) {
  return {
    description:
      "Extract clean content from one or more URLs using Tavily. Handles JS-rendered pages. Supports query-focused chunking.",
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const urls = Array.isArray(rawParams.urls)
        ? (rawParams.urls as string[]).filter(Boolean)
        : [];
      if (urls.length === 0) {
        throw new Error("tavily_extract requires at least one URL.");
      }
      const query = readStringParam(rawParams, "query") || undefined;
      const extractDepth = readStringParam(rawParams, "extract_depth") || undefined;
      const chunksPerSource = readNumberParam(rawParams, "chunks_per_source", {
        integer: true,
      });
      if (chunksPerSource !== undefined && !query) {
        throw new Error("tavily_extract requires query when chunks_per_source is set.");
      }
      const includeImages = rawParams.include_images === true;

      return jsonResult(
        await runTavilyExtract({
          cfg: api.config,
          chunksPerSource,
          extractDepth,
          includeImages,
          query,
          urls,
        }),
      );
    },
    label: "Tavily Extract",
    name: "tavily_extract",
    parameters: TavilyExtractToolSchema,
  };
}
