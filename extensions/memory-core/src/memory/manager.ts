import type { DatabaseSync } from "node:sqlite";
import type { FSWatcher } from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
  createSubsystemLogger,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { extractKeywords } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  type MemoryEmbeddingProbeResult,
  type MemoryProviderStatus,
  type MemorySearchManager,
  type MemorySearchResult,
  type MemorySource,
  type MemorySyncProgressUpdate,
  readMemoryFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderRequest,
  type EmbeddingProviderResult,
  type EmbeddingProviderRuntime,
  createEmbeddingProvider,
} from "./embeddings.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import { awaitPendingManagerWork, startAsyncSearchSync } from "./manager-async-state.js";
import { MEMORY_BATCH_FAILURE_LIMIT } from "./manager-batch-state.js";
import {
  closeManagedCacheEntries,
  getOrCreateManagedCacheEntry,
  resolveSingletonManagedCache,
} from "./manager-cache.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import {
  resolveMemoryPrimaryProviderRequest,
  resolveMemoryProviderState,
} from "./manager-provider-state.js";
import { resolveMemorySearchPreflight } from "./manager-search-preflight.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import {
  collectMemoryStatusAggregate,
  resolveInitialMemoryDirty,
  resolveStatusProviderInfo,
} from "./manager-status-state.js";
import {
  type MemoryReadonlyRecoveryState,
  enqueueMemoryTargetedSessionSync,
  extractMemoryErrorReason,
  isMemoryReadonlyDbError,
  runMemorySyncWithReadonlyRecovery,
} from "./manager-sync-control.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const MEMORY_INDEX_MANAGER_CACHE_KEY = Symbol.for("openclaw.memoryIndexManagerCache");
const log = createSubsystemLogger("memory");

const { cache: INDEX_CACHE, pending: INDEX_CACHE_PENDING } =
  resolveSingletonManagedCache<MemoryIndexManager>(MEMORY_INDEX_MANAGER_CACHE_KEY);
export async function closeAllMemoryIndexManagers(): Promise<void> {
  await closeManagedCacheEntries({
    cache: INDEX_CACHE,
    onCloseError: (err) => {
      log.warn(`failed to close memory index manager: ${String(err)}`);
    },
    pending: INDEX_CACHE_PENDING,
  });
}

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey: string;
  protected readonly cfg: OpenClawConfig;
  protected readonly agentId: string;
  protected readonly workspaceDir: string;
  protected readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null;
  private readonly requestedProvider: EmbeddingProviderRequest;
  private providerInitPromise: Promise<void> | null = null;
  private providerInitialized = false;
  protected fallbackFrom?: EmbeddingProviderId;
  protected fallbackReason?: string;
  private providerUnavailableReason?: string;
  protected providerRuntime?: EmbeddingProviderRuntime;
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0;
  protected batchFailureLastError?: string;
  protected batchFailureLastProvider?: string;
  protected batchFailureLock: Promise<void> = Promise.resolve();
  protected db: DatabaseSync;
  protected readonly sources: Set<MemorySource>;
  protected providerKey: string;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  protected sessionsDirty = false;
  protected sessionsDirtyFiles = new Set<string>();
  protected sessionPendingFiles = new Set<string>();
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();
  private sessionWarm = new Set<string>();
  private syncing: Promise<void> | null = null;
  private queuedSessionFiles = new Set<string>();
  private queuedSessionSync: Promise<void> | null = null;
  private readonlyRecoveryAttempts = 0;
  private readonlyRecoverySuccesses = 0;
  private readonlyRecoveryFailures = 0;
  private readonlyRecoveryLastError?: string;

  private static async loadProviderResult(params: {
    cfg: OpenClawConfig;
    agentId: string;
    settings: ResolvedMemorySearchConfig;
  }): Promise<EmbeddingProviderResult> {
    return await createEmbeddingProvider({
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      config: params.cfg,
      ...resolveMemoryPrimaryProviderRequest({ settings: params.settings }),
    });
  }

  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const purpose = params.purpose === "status" ? "status" : "default";
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}:${purpose}`;
    const statusOnly = params.purpose === "status";
    return await getOrCreateManagedCacheEntry({
      bypassCache: statusOnly,
      cache: INDEX_CACHE,
      create: async () =>
        new MemoryIndexManager({
          agentId,
          cacheKey: key,
          cfg,
          purpose: params.purpose,
          settings,
          workspaceDir,
        }),
      key,
      pending: INDEX_CACHE_PENDING,
    });
  }

  private constructor(params: {
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult?: EmbeddingProviderResult;
    purpose?: "default" | "status";
  }) {
    super();
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;
    this.provider = null;
    this.requestedProvider = params.settings.provider;
    if (params.providerResult) {
      this.applyProviderResult(params.providerResult);
    }
    this.sources = new Set(params.settings.sources);
    this.db = this.openDatabase();
    this.providerKey = this.computeProviderKey();
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };
    this.fts = { available: false, enabled: params.settings.query.hybrid.enabled };
    this.ensureSchema();
    this.vector = {
      available: null,
      enabled: params.settings.store.vector.enabled,
      extensionPath: params.settings.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    const statusOnly = params.purpose === "status";
    if (!statusOnly) {
      this.ensureWatcher();
      this.ensureSessionListener();
      this.ensureIntervalSync();
    }
    this.dirty = resolveInitialMemoryDirty({
      hasIndexedMeta: Boolean(meta),
      hasMemorySource: this.sources.has("memory"),
      statusOnly,
    });
    this.batch = this.resolveBatchConfig();
  }

  private applyProviderResult(providerResult: EmbeddingProviderResult): void {
    const providerState = resolveMemoryProviderState(providerResult);
    this.provider = providerState.provider;
    this.fallbackFrom = providerState.fallbackFrom;
    this.fallbackReason = providerState.fallbackReason;
    this.providerUnavailableReason = providerState.providerUnavailableReason;
    this.providerRuntime = providerState.providerRuntime;
    this.providerInitialized = true;
  }

  private async ensureProviderInitialized(): Promise<void> {
    if (this.providerInitialized) {
      return;
    }
    if (!this.providerInitPromise) {
      this.providerInitPromise = (async () => {
        const providerResult = await MemoryIndexManager.loadProviderResult({
          agentId: this.agentId,
          cfg: this.cfg,
          settings: this.settings,
        });
        this.applyProviderResult(providerResult);
        this.providerKey = this.computeProviderKey();
        this.batch = this.resolveBatchConfig();
      })();
    }
    try {
      await this.providerInitPromise;
    } finally {
      if (this.providerInitialized) {
        this.providerInitPromise = null;
      }
    }
  }

  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    void this.sync({ reason: "session-start" }).catch((error) => {
      log.warn(`memory sync failed (session-start): ${String(error)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    let hasIndexedContent = this.hasIndexedContent();
    if (!hasIndexedContent) {
      try {
        // A fresh process can receive its first search before background watch/session
        // Syncs have built the index. Force one synchronous bootstrap so the first
        // Lookup after restart does not fail closed with empty results.
        await this.sync({ force: true, reason: "search" });
      } catch (error) {
        log.warn(`memory sync failed (search-bootstrap): ${String(error)}`);
      }
      hasIndexedContent = this.hasIndexedContent();
    }
    const preflight = resolveMemorySearchPreflight({
      hasIndexedContent,
      query,
    });
    if (!preflight.shouldSearch) {
      return [];
    }
    const cleaned = preflight.normalizedQuery;
    void this.warmSession(opts?.sessionKey);
    startAsyncSearchSync({
      dirty: this.dirty,
      enabled: this.settings.sync.onSearch,
      onError: (err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      },
      sessionsDirty: this.sessionsDirty,
      sync: async (params) => await this.sync(params),
    });
    if (preflight.shouldInitializeProvider) {
      await this.ensureProviderInitialized();
    }
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const {hybrid} = this.settings.query;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    // FTS-only mode: no embedding provider available
    if (!this.provider) {
      if (!this.fts.enabled || !this.fts.available) {
        log.warn("memory search: no provider and FTS unavailable");
        return [];
      }

      const fullQueryResults = await this.searchKeyword(cleaned, candidates).catch(() => []);
      const resultSets =
        fullQueryResults.length > 0
          ? [fullQueryResults]
          : await Promise.all(
              // Fallback: broaden recall for conversational queries when the
              // Exact AND query is too strict to return any results.
              (() => {
                const keywords = extractKeywords(cleaned, {
                  ftsTokenizer: this.settings.store.fts.tokenizer,
                });
                const searchTerms = keywords.length > 0 ? keywords : [cleaned];
                return searchTerms.map((term) =>
                  this.searchKeyword(term, candidates).catch(() => []),
                );
              })(),
            );

      // Merge and deduplicate results, keeping highest score for each chunk
      const seenIds = new Map<string, (typeof resultSets)[0][0]>();
      for (const results of resultSets) {
        for (const result of results) {
          const existing = seenIds.get(result.id);
          if (!existing || result.score > existing.score) {
            seenIds.set(result.id, result);
          }
        }
      }

      const merged = [...seenIds.values()];
      const decayed = await applyTemporalDecayToHybridResults({
        results: merged,
        temporalDecay: hybrid.temporalDecay,
        workspaceDir: this.workspaceDir,
      });
      const sorted = decayed.toSorted((a, b) => b.score - a.score);
      return this.selectScoredResults(sorted, maxResults, minScore, 0);
    }

    // If FTS isn't available, hybrid mode cannot use keyword search; degrade to vector-only.
    const keywordResults =
      hybrid.enabled && this.fts.enabled && this.fts.available
        ? await this.searchKeyword(cleaned, candidates).catch(() => [])
        : [];

    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];

    if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const merged = await this.mergeHybridResults({
      keyword: keywordResults,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
      textWeight: hybrid.textWeight,
      vector: vectorResults,
      vectorWeight: hybrid.vectorWeight,
    });
    const strict = merged.filter((entry) => entry.score >= minScore);
    if (strict.length > 0 || keywordResults.length === 0) {
      return strict.slice(0, maxResults);
    }

    // Hybrid defaults can produce keyword-only matches with max score equal to
    // TextWeight (for example 0.3). If minScore is higher (for example 0.35),
    // These exact lexical hits get filtered out even when they are the only
    // Relevant results.
    const relaxedMinScore = Math.min(minScore, hybrid.textWeight);
    const keywordKeys = new Set(
      keywordResults.map(
        (entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`,
      ),
    );
    return this.selectScoredResults(
      merged.filter((entry) =>
        keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`),
      ),
      maxResults,
      minScore,
      relaxedMinScore,
    );
  }

  private selectScoredResults<T extends MemorySearchResult & { score: number }>(
    results: T[],
    maxResults: number,
    minScore: number,
    relaxedMinScore = minScore,
  ): T[] {
    const strict = results.filter((entry) => entry.score >= minScore);
    if (strict.length > 0) {
      return strict.slice(0, maxResults);
    }
    return results.filter((entry) => entry.score >= relaxedMinScore).slice(0, maxResults);
  }

  private hasIndexedContent(): boolean {
    const chunkRow = this.db.prepare(`SELECT 1 as found FROM chunks LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    if (chunkRow?.found === 1) {
      return true;
    }
    if (!this.fts.enabled || !this.fts.available) {
      return false;
    }
    const ftsRow = this.db.prepare(`SELECT 1 as found FROM ${FTS_TABLE} LIMIT 1`).get() as
      | {
          found?: number;
        }
      | undefined;
    return ftsRow?.found === 1;
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<(MemorySearchResult & { id: string })[]> {
    // This method should never be called without a provider
    if (!this.provider) {
      return [];
    }
    const results = await searchVector({
      db: this.db,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      limit,
      providerModel: this.provider.model,
      queryVec,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilterChunks: this.buildSourceFilter(),
      sourceFilterVec: this.buildSourceFilter("c"),
      vectorTable: VECTOR_TABLE,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<(MemorySearchResult & { id: string; textScore: number })[]> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter();
    // In FTS-only mode (no provider), search all models; otherwise filter by current provider's model
    const providerModel = this.provider?.model;
    const results = await searchKeyword({
      bm25RankToScore,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      db: this.db,
      ftsTable: FTS_TABLE,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      limit,
      providerModel,
      query,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  private mergeHybridResults(params: {
    vector: (MemorySearchResult & { id: string })[];
    keyword: (MemorySearchResult & { id: string; textScore: number })[];
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
  }): Promise<MemorySearchResult[]> {
    return mergeHybridResults({
      keyword: params.keyword.map((r) => ({
        endLine: r.endLine,
        id: r.id,
        path: r.path,
        snippet: r.snippet,
        source: r.source,
        startLine: r.startLine,
        textScore: r.textScore,
      })),
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      textWeight: params.textWeight,
      vector: params.vector.map((r) => ({
        endLine: r.endLine,
        id: r.id,
        path: r.path,
        snippet: r.snippet,
        source: r.source,
        startLine: r.startLine,
        vectorScore: r.score,
      })),
      vectorWeight: params.vectorWeight,
      workspaceDir: this.workspaceDir,
    }).then((entries) => entries.map((entry) => entry as MemorySearchResult));
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.ensureProviderInitialized();
    if (this.syncing) {
      if (params?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
        return this.enqueueTargetedSessionSync(params.sessionFiles);
      }
      return this.syncing;
    }
    this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  private enqueueTargetedSessionSync(sessionFiles?: string[]): Promise<void> {
    return enqueueMemoryTargetedSessionSync(
      {
        getQueuedSessionFiles: () => this.queuedSessionFiles,
        getQueuedSessionSync: () => this.queuedSessionSync,
        getSyncing: () => this.syncing,
        isClosed: () => this.closed,
        setQueuedSessionSync: (value) => {
          this.queuedSessionSync = value;
        },
        sync: async (params) => await this.sync(params),
      },
      sessionFiles,
    );
  }

  private isReadonlyDbError(err: unknown): boolean {
    return isMemoryReadonlyDbError(err);
  }

  private extractErrorReason(err: unknown): string {
    return extractMemoryErrorReason(err);
  }

  private async runSyncWithReadonlyRecovery(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    const getClosed = () => this.closed;
    const getDb = () => this.db;
    const setDb = (value: DatabaseSync) => {
      this.db = value;
    };
    const getVectorReady = () => this.vectorReady;
    const setVectorReady = (value: Promise<boolean> | null) => {
      this.vectorReady = value;
    };
    const getReadonlyRecoveryAttempts = () => this.readonlyRecoveryAttempts;
    const setReadonlyRecoveryAttempts = (value: number) => {
      this.readonlyRecoveryAttempts = value;
    };
    const getReadonlyRecoverySuccesses = () => this.readonlyRecoverySuccesses;
    const setReadonlyRecoverySuccesses = (value: number) => {
      this.readonlyRecoverySuccesses = value;
    };
    const getReadonlyRecoveryFailures = () => this.readonlyRecoveryFailures;
    const setReadonlyRecoveryFailures = (value: number) => {
      this.readonlyRecoveryFailures = value;
    };
    const getReadonlyRecoveryLastError = () => this.readonlyRecoveryLastError;
    const setReadonlyRecoveryLastError = (value: string | undefined) => {
      this.readonlyRecoveryLastError = value;
    };
    const state: MemoryReadonlyRecoveryState = {
      get closed() {
        return getClosed();
      },
      get db() {
        return getDb();
      },
      set db(value) {
        setDb(value);
      },
      ensureSchema: () => this.ensureSchema(),
      openDatabase: () => this.openDatabase(),
      readMeta: () => this.readMeta() ?? undefined,
      get readonlyRecoveryAttempts() {
        return getReadonlyRecoveryAttempts();
      },
      set readonlyRecoveryAttempts(value) {
        setReadonlyRecoveryAttempts(value);
      },
      get readonlyRecoveryFailures() {
        return getReadonlyRecoveryFailures();
      },
      set readonlyRecoveryFailures(value) {
        setReadonlyRecoveryFailures(value);
      },
      get readonlyRecoveryLastError() {
        return getReadonlyRecoveryLastError();
      },
      set readonlyRecoveryLastError(value) {
        setReadonlyRecoveryLastError(value);
      },
      get readonlyRecoverySuccesses() {
        return getReadonlyRecoverySuccesses();
      },
      set readonlyRecoverySuccesses(value) {
        setReadonlyRecoverySuccesses(value);
      },
      runSync: (nextParams) => this.runSync(nextParams),
      vector: this.vector,
      get vectorReady() {
        return getVectorReady();
      },
      set vectorReady(value) {
        setVectorReady(value);
      },
    };
    await runMemorySyncWithReadonlyRecovery(state, params);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    return await readMemoryFile({
      extraPaths: this.settings.extraPaths,
      from: params.from,
      lines: params.lines,
      relPath: params.relPath,
      workspaceDir: this.workspaceDir,
    });
  }

  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();
    const aggregateState = collectMemoryStatusAggregate({
      db: {
        prepare: (sql) => ({
          all: (...args) =>
            this.db.prepare(sql).all(...args) as {
              kind: "files" | "chunks";
              source: MemorySource;
              c: number;
            }[],
        }),
      },
      sourceFilterParams: sourceFilter.params,
      sourceFilterSql: sourceFilter.sql,
      sources: this.sources,
    });

    const providerInfo = resolveStatusProviderInfo({
      configuredModel: this.settings.model || undefined,
      provider: this.provider,
      providerInitialized: this.providerInitialized,
      requestedProvider: this.requestedProvider,
    });

    return {
      backend: "builtin",
      batch: {
        concurrency: this.batch.concurrency,
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
        limit: MEMORY_BATCH_FAILURE_LIMIT,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        wait: this.batch.wait,
      },
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      chunks: aggregateState.chunks,
      custom: {
        providerUnavailableReason: this.providerUnavailableReason,
        readonlyRecovery: {
          attempts: this.readonlyRecoveryAttempts,
          failures: this.readonlyRecoveryFailures,
          lastError: this.readonlyRecoveryLastError,
          successes: this.readonlyRecoverySuccesses,
        },
        searchMode: providerInfo.searchMode,
      },
      dbPath: this.settings.store.path,
      dirty: this.dirty || this.sessionsDirty,
      extraPaths: this.settings.extraPaths,
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      files: aggregateState.files,
      fts: {
        available: this.fts.available,
        enabled: this.fts.enabled,
        error: this.fts.loadError,
      },
      model: providerInfo.model,
      provider: providerInfo.provider,
      requestedProvider: this.requestedProvider,
      sourceCounts: aggregateState.sourceCounts,
      sources: [...this.sources],
      vector: {
        available: this.vector.available ?? undefined,
        dims: this.vector.dims,
        enabled: this.vector.enabled,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
      },
      workspaceDir: this.workspaceDir,
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    await this.ensureProviderInitialized();
    // FTS-only mode: vector search not available
    if (!this.provider) {
      return false;
    }
    return this.ensureVectorReady();
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    await this.ensureProviderInitialized();
    // FTS-only mode: embeddings not available but search still works
    if (!this.provider) {
      return {
        error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
        ok: false,
      };
    }
    try {
      await this.embedBatchWithRetry(["ping"]);
      return { ok: true };
    } catch (error) {
      const message = formatErrorMessage(error);
      return { error: message, ok: false };
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const pendingSync = this.syncing;
    const pendingProviderInit = this.providerInitPromise;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    await awaitPendingManagerWork({ pendingProviderInit, pendingSync });
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }
}
