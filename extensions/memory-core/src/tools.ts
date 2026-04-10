import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  type AnyAgentTool,
  type OpenClawConfig,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
  clampResultsByInjectedChars,
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  MemoryGetSchema,
  MemorySearchSchema,
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryCorpusSupplementResult,
  getMemoryManagerContext,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  searchMemoryCorpusSupplements,
} from "./tools.shared.js";

function buildRecallKey(
  result: Pick<MemorySearchResult, "source" | "path" | "startLine" | "endLine">,
): string {
  return `${result.source}:${result.path}:${result.startLine}:${result.endLine}`;
}

function resolveRecallTrackingResults(
  rawResults: MemorySearchResult[],
  surfacedResults: MemorySearchResult[],
): MemorySearchResult[] {
  if (surfacedResults.length === 0 || rawResults.length === 0) {
    return surfacedResults;
  }
  const rawByKey = new Map<string, MemorySearchResult>();
  for (const raw of rawResults) {
    const key = buildRecallKey(raw);
    if (!rawByKey.has(key)) {
      rawByKey.set(key, raw);
    }
  }
  return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced)) ?? surfaced);
}

function queueShortTermRecallTracking(params: {
  workspaceDir?: string;
  query: string;
  rawResults: MemorySearchResult[];
  surfacedResults: MemorySearchResult[];
  timezone?: string;
}): void {
  const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
  void recordShortTermRecalls({
    query: params.query,
    results: trackingResults,
    timezone: params.timezone,
    workspaceDir: params.workspaceDir,
  }).catch(() => {
    // Recall tracking is best-effort and must never block memory recall.
  });
}

async function getSupplementMemoryReadResult(params: {
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}) {
  const supplement = await getMemoryCorpusSupplementResult({
    agentSessionKey: params.agentSessionKey,
    corpus: params.corpus,
    fromLine: params.from,
    lineCount: params.lines,
    lookup: params.relPath,
  });
  if (!supplement) {
    return null;
  }
  const { content, ...rest } = supplement;
  return {
    ...rest,
    text: content,
  };
}

async function resolveMemoryReadFailureResult(params: {
  error: unknown;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  if (params.requestedCorpus === "all") {
    const supplement = await getSupplementMemoryReadResult({
      agentSessionKey: params.agentSessionKey,
      corpus: params.requestedCorpus,
      from: params.from,
      lines: params.lines,
      relPath: params.relPath,
    });
    if (supplement) {
      return jsonResult(supplement);
    }
  }
  const message = formatErrorMessage(params.error);
  return jsonResult({ disabled: true, error: message, path: params.relPath, text: "" });
}

async function executeMemoryReadResult<T>(params: {
  read: () => Promise<T>;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  try {
    return jsonResult(await params.read());
  } catch (error) {
    return await resolveMemoryReadFailureResult({
      agentSessionKey: params.agentSessionKey,
      error,
      from: params.from,
      lines: params.lines,
      relPath: params.relPath,
      requestedCorpus: params.requestedCorpus,
    });
  }
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
        const requestedCorpus = readStringParam(params, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | undefined;
        const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const shouldQueryMemory = requestedCorpus !== "wiki";
        const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
        const memory = shouldQueryMemory ? await getMemoryManagerContext({ agentId, cfg }) : null;
        if (shouldQueryMemory && memory && "error" in memory && !shouldQuerySupplements) {
          return jsonResult(buildMemorySearchUnavailableResult(memory.error));
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          let rawResults: MemorySearchResult[] = [];
          let surfacedMemoryResults: (MemorySearchResult & { corpus: "memory" })[] = [];
          let provider: string | undefined;
          let model: string | undefined;
          let fallback: unknown;
          let searchMode: string | undefined;
          if (shouldQueryMemory && memory && !("error" in memory)) {
            rawResults = await memory.manager.search(query, {
              maxResults,
              minScore,
              sessionKey: options.agentSessionKey,
            });
            const status = memory.manager.status();
            const decorated = decorateCitations(rawResults, includeCitations);
            const resolved = resolveMemoryBackendConfig({ agentId, cfg });
            const memoryResults =
              status.backend === "qmd"
                ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
                : decorated;
            surfacedMemoryResults = memoryResults.map((result) => ({
              ...result,
              corpus: "memory" as const,
            }));
            const sleepTimezone = resolveMemoryDeepDreamingConfig({
              cfg,
              pluginConfig: resolveMemoryCorePluginConfig(cfg),
            }).timezone;
            queueShortTermRecallTracking({
              query,
              rawResults,
              surfacedResults: memoryResults,
              timezone: sleepTimezone,
              workspaceDir: status.workspaceDir,
            });
            ({ provider } = status);
            ({ model } = status);
            ({ fallback } = status);
            searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
          }
          const supplementResults = shouldQuerySupplements
            ? await searchMemoryCorpusSupplements({
                agentSessionKey: options.agentSessionKey,
                corpus: requestedCorpus,
                maxResults,
                query,
              })
            : [];
          const results = [...surfacedMemoryResults, ...supplementResults]
            .toSorted((left, right) => {
              if (left.score !== right.score) {
                return right.score - left.score;
              }
              return left.path.localeCompare(right.path);
            })
            .slice(0, Math.max(1, maxResults ?? 10));
          return jsonResult({
            citations: citationsMode,
            fallback,
            mode: searchMode,
            model,
            provider,
            results,
          });
        } catch (error) {
          const message = formatErrorMessage(error);
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
    label: "Memory Search",
    name: "memory_search",
    options,
    parameters: MemorySearchSchema,
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; `corpus=wiki` reads from registered compiled-wiki supplements. Use after search to pull only the needed lines and keep context small.",
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const requestedCorpus = readStringParam(params, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | undefined;
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        if (requestedCorpus === "wiki") {
          const supplement = await getSupplementMemoryReadResult({
            agentSessionKey: options.agentSessionKey,
            corpus: requestedCorpus,
            from: from ?? undefined,
            lines: lines ?? undefined,
            relPath,
          });
          return jsonResult(
            supplement ?? {
              disabled: true,
              error: "wiki corpus result not found",
              path: relPath,
              text: "",
            },
          );
        }
        const resolved = resolveMemoryBackendConfig({ agentId, cfg });
        if (resolved.backend === "builtin") {
          return await executeMemoryReadResult({
            agentSessionKey: options.agentSessionKey,
            from: from ?? undefined,
            lines: lines ?? undefined,
            read: async () =>
              await readAgentMemoryFile({
                cfg,
                agentId,
                relPath,
                from: from ?? undefined,
                lines: lines ?? undefined,
              }),
            relPath,
            requestedCorpus,
          });
        }
        const memory = await getMemoryManagerContextWithPurpose({
          agentId,
          cfg,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult({ disabled: true, error: memory.error, path: relPath, text: "" });
        }
        return await executeMemoryReadResult({
          agentSessionKey: options.agentSessionKey,
          from: from ?? undefined,
          lines: lines ?? undefined,
          read: async () =>
            await memory.manager.readFile({
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          relPath,
          requestedCorpus,
        });
      },
    label: "Memory Get",
    name: "memory_get",
    options,
    parameters: MemoryGetSchema,
  });
}
