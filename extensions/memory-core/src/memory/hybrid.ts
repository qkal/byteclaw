import { DEFAULT_MMR_CONFIG, type MMRConfig, applyMMRToHybridResults } from "./mmr.js";
import {
  DEFAULT_TEMPORAL_DECAY_CONFIG,
  type TemporalDecayConfig,
  applyTemporalDecayToHybridResults,
} from "./temporal-decay.js";

export type HybridSource = string;

export { type MMRConfig, DEFAULT_MMR_CONFIG };
export { type TemporalDecayConfig, DEFAULT_TEMPORAL_DECAY_CONFIG };

export interface HybridVectorResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
}

export interface HybridKeywordResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
}

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  workspaceDir?: string;
  /** MMR configuration for diversity-aware re-ranking */
  mmr?: Partial<MMRConfig>;
  /** Temporal decay configuration for recency-aware scoring */
  temporalDecay?: Partial<TemporalDecayConfig>;
  /** Test hook for deterministic time-dependent behavior */
  nowMs?: number;
}): Promise<
  {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: HybridSource;
  }[]
> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      endLine: r.endLine,
      id: r.id,
      path: r.path,
      snippet: r.snippet,
      source: r.source,
      startLine: r.startLine,
      textScore: 0,
      vectorScore: r.vectorScore,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, {
        endLine: r.endLine,
        id: r.id,
        path: r.path,
        snippet: r.snippet,
        source: r.source,
        startLine: r.startLine,
        textScore: r.textScore,
        vectorScore: 0,
      });
    }
  }

  const merged = [...byId.values()].map((entry) => {
    const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
    return {
      endLine: entry.endLine,
      path: entry.path,
      score,
      snippet: entry.snippet,
      source: entry.source,
      startLine: entry.startLine,
    };
  });

  const temporalDecayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const decayed = await applyTemporalDecayToHybridResults({
    nowMs: params.nowMs,
    results: merged,
    temporalDecay: temporalDecayConfig,
    workspaceDir: params.workspaceDir,
  });
  const sorted = decayed.toSorted((a, b) => b.score - a.score);

  // Apply MMR re-ranking if enabled
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  if (mmrConfig.enabled) {
    return applyMMRToHybridResults(sorted, mmrConfig);
  }

  return sorted;
}
