import type { OpenClawConfig } from "../api.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";

export function createWikiCorpusSupplement(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
}) {
  return {
    get: async (input: {
      lookup: string;
      fromLine?: number;
      lineCount?: number;
      agentSessionKey?: string;
    }) =>
      await getMemoryWikiPage({
        agentSessionKey: input.agentSessionKey,
        appConfig: params.appConfig,
        config: params.config,
        fromLine: input.fromLine,
        lineCount: input.lineCount,
        lookup: input.lookup,
        searchBackend: "local",
        searchCorpus: "wiki",
      }),
    search: async (input: { query: string; maxResults?: number; agentSessionKey?: string }) =>
      await searchMemoryWiki({
        agentSessionKey: input.agentSessionKey,
        appConfig: params.appConfig,
        config: params.config,
        maxResults: input.maxResults,
        query: input.query,
        searchBackend: "local",
        searchCorpus: "wiki",
      }),
  };
}
