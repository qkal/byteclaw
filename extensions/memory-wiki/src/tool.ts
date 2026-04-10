import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import {
  type ResolvedMemoryWikiConfig,
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
} from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";

const WikiStatusSchema = Type.Object({}, { additionalProperties: false });
const WikiLintSchema = Type.Object({}, { additionalProperties: false });
const WikiSearchBackendSchema = Type.Union(
  WIKI_SEARCH_BACKENDS.map((value) => Type.Literal(value)),
);
const WikiSearchCorpusSchema = Type.Union(WIKI_SEARCH_CORPORA.map((value) => Type.Literal(value)));
const WikiSearchSchema = Type.Object(
  {
    backend: Type.Optional(WikiSearchBackendSchema),
    corpus: Type.Optional(WikiSearchCorpusSchema),
    maxResults: Type.Optional(Type.Number({ minimum: 1 })),
    query: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const WikiGetSchema = Type.Object(
  {
    backend: Type.Optional(WikiSearchBackendSchema),
    corpus: Type.Optional(WikiSearchCorpusSchema),
    fromLine: Type.Optional(Type.Number({ minimum: 1 })),
    lineCount: Type.Optional(Type.Number({ minimum: 1 })),
    lookup: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const WikiClaimEvidenceSchema = Type.Object(
  {
    lines: Type.Optional(Type.String({ minLength: 1 })),
    note: Type.Optional(Type.String({ minLength: 1 })),
    path: Type.Optional(Type.String({ minLength: 1 })),
    sourceId: Type.Optional(Type.String({ minLength: 1 })),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
    weight: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);
const WikiClaimSchema = Type.Object(
  {
    confidence: Type.Optional(Type.Number({ maximum: 1, minimum: 0 })),
    evidence: Type.Optional(Type.Array(WikiClaimEvidenceSchema)),
    id: Type.Optional(Type.String({ minLength: 1 })),
    status: Type.Optional(Type.String({ minLength: 1 })),
    text: Type.String({ minLength: 1 }),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const WikiApplySchema = Type.Object(
  {
    body: Type.Optional(Type.String({ minLength: 1 })),
    claims: Type.Optional(Type.Array(WikiClaimSchema)),
    confidence: Type.Optional(Type.Union([Type.Number({ maximum: 1, minimum: 0 }), Type.Null()])),
    contradictions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    lookup: Type.Optional(Type.String({ minLength: 1 })),
    op: Type.Union([Type.Literal("create_synthesis"), Type.Literal("update_metadata")]),
    questions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    status: Type.Optional(Type.String({ minLength: 1 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

async function syncImportedSourcesIfNeeded(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
) {
  await syncMemoryWikiImportedSources({ appConfig, config });
}

interface WikiToolMemoryContext {
  agentId?: string;
  agentSessionKey?: string;
}

export function createWikiStatusTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    description:
      "Inspect the current memory wiki vault mode, health, and Obsidian CLI availability.",
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig);
      const status = await resolveMemoryWikiStatus(config, {
        appConfig,
      });
      return {
        content: [{ text: renderMemoryWikiStatus(status), type: "text" }],
        details: status,
      };
    },
    label: "Wiki Status",
    name: "wiki_status",
    parameters: WikiStatusSchema,
  };
}

export function createWikiSearchTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    description:
      "Search wiki pages and, when shared search is enabled, the active memory corpus by title, path, id, or body text.",
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        query: string;
        maxResults?: number;
        backend?: ResolvedMemoryWikiConfig["search"]["backend"];
        corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
      };
      await syncImportedSourcesIfNeeded(config, appConfig);
      const results = await searchMemoryWiki({
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        appConfig,
        config,
        maxResults: params.maxResults,
        query: params.query,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
      });
      const text =
        results.length === 0
          ? "No wiki or memory results."
          : results
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}\nSnippet: ${result.snippet}`,
              )
              .join("\n\n");
      return {
        content: [{ text, type: "text" }],
        details: { results },
      };
    },
    label: "Wiki Search",
    name: "wiki_search",
    parameters: WikiSearchSchema,
  };
}

export function createWikiLintTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    description:
      "Lint the wiki vault and surface structural issues, provenance gaps, contradictions, and open questions.",
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await lintMemoryWikiVault(config);
      const contradictions = result.issuesByCategory.contradictions.length;
      const openQuestions = result.issuesByCategory["open-questions"].length;
      const provenance = result.issuesByCategory.provenance.length;
      const errors = result.issues.filter((issue) => issue.severity === "error").length;
      const warnings = result.issues.filter((issue) => issue.severity === "warning").length;
      const summary =
        result.issueCount === 0
          ? "No wiki lint issues."
          : [
              `Issues: ${result.issueCount} total (${errors} errors, ${warnings} warnings)`,
              `Contradictions: ${contradictions}`,
              `Open questions: ${openQuestions}`,
              `Provenance gaps: ${provenance}`,
              `Report: ${result.reportPath}`,
            ].join("\n");
      return {
        content: [{ text: summary, type: "text" }],
        details: result,
      };
    },
    label: "Wiki Lint",
    name: "wiki_lint",
    parameters: WikiLintSchema,
  };
}

export function createWikiApplyTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    description:
      "Apply narrow wiki mutations for syntheses and page metadata without freeform markdown surgery.",
    execute: async (_toolCallId, rawParams) => {
      const mutation = normalizeMemoryWikiMutationInput(rawParams);
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await applyMemoryWikiMutation({ config, mutation });
      const action = result.changed ? "Updated" : "No changes for";
      const compileSummary =
        result.compile.updatedFiles.length > 0
          ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.`
          : "Indexes unchanged.";
      return {
        content: [
          {
            text: `${action} ${result.pagePath} via ${result.operation}. ${compileSummary}`,
            type: "text",
          },
        ],
        details: result,
      };
    },
    label: "Wiki Apply",
    name: "wiki_apply",
    parameters: WikiApplySchema,
  };
}

export function createWikiGetTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    description:
      "Read a wiki page by id or relative path, or fall back to the active memory corpus when shared search is enabled.",
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        lookup: string;
        fromLine?: number;
        lineCount?: number;
        backend?: ResolvedMemoryWikiConfig["search"]["backend"];
        corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
      };
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await getMemoryWikiPage({
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        appConfig,
        config,
        fromLine: params.fromLine,
        lineCount: params.lineCount,
        lookup: params.lookup,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
      });
      if (!result) {
        return {
          content: [{ text: `Wiki page not found: ${params.lookup}`, type: "text" }],
          details: { found: false },
        };
      }
      return {
        content: [{ text: result.content, type: "text" }],
        details: { found: true, ...result },
      };
    },
    label: "Wiki Get",
    name: "wiki_get",
    parameters: WikiGetSchema,
  };
}
