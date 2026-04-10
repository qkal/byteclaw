import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildCaseInsensitiveExtensionGlob,
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  type OpenClawConfig,
  type ResolvedMemorySearchConfig,
  createSubsystemLogger,
  onSessionTranscriptUpdate,
  resolveAgentDir,
  resolveSessionTranscriptsDirForAgent,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  type SessionFileEntry,
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  type MemoryFileEntry,
  type MemorySource,
  type MemorySyncProgressUpdate,
  buildFileEntry,
  ensureMemoryIndexSchema,
  isFileMissingError,
  listMemoryFiles,
  loadSqliteVecExtension,
  normalizeExtraMemoryPaths,
  runWithConcurrency,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  type EmbeddingProvider,
  type EmbeddingProviderId,
  type EmbeddingProviderRuntime,
  createEmbeddingProvider,
} from "./embeddings.js";
import { runMemoryAtomicReindex } from "./manager-atomic-reindex.js";
import { openMemoryDatabaseAtPath } from "./manager-db.js";
import {
  applyMemoryFallbackProviderState,
  resolveMemoryFallbackProviderRequest,
} from "./manager-provider-state.js";
import {
  type MemoryIndexMeta,
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  shouldRunFullMemoryReindex,
} from "./manager-reindex-state.js";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";
import { resolveMemorySessionSyncPlan } from "./manager-session-sync-state.js";
import {
  loadMemorySourceFileState,
  resolveMemorySourceExistingHash,
} from "./manager-source-state.js";
import { runMemoryTargetedSessionSync } from "./manager-targeted-sync.js";

interface MemorySyncProgressState {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
}

const META_KEY = "memory_index_meta_v1";
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

const log = createSubsystemLogger("memory");

function shouldIgnoreMemoryWatchPath(watchPath: string): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment));
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

export function runDetachedMemorySync(sync: () => Promise<void>, reason: "interval" | "watch") {
  void sync().catch((error) => {
    log.warn(`memory sync failed (${reason}): ${String(error)}`);
  });
}

export abstract class MemoryManagerSyncOps {
  protected abstract readonly cfg: OpenClawConfig;
  protected abstract readonly agentId: string;
  protected abstract readonly workspaceDir: string;
  protected abstract readonly settings: ResolvedMemorySearchConfig;
  protected provider: EmbeddingProvider | null = null;
  protected fallbackFrom?: EmbeddingProviderId;
  protected providerRuntime?: EmbeddingProviderRuntime;
  protected abstract batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected readonly sources = new Set<MemorySource>();
  protected providerKey: string | null = null;
  protected abstract readonly vector: {
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
  } = { available: false, enabled: false };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected sessionWatchTimer: NodeJS.Timeout | null = null;
  protected sessionUnsubscribe: (() => void) | null = null;
  protected fallbackReason?: string;
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
  private lastMetaSerialized: string | null = null;

  protected abstract readonly cache: { enabled: boolean; maxEntries?: number };
  protected abstract db: DatabaseSync;
  protected abstract computeProviderKey(): string;
  protected abstract sync(params?: {
    reason?: string;
    force?: boolean;
    forceSessions?: boolean;
    sessionFile?: string;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  protected abstract withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>;
  protected abstract getIndexConcurrency(): number;
  protected abstract pruneEmbeddingCacheIfNeeded(): void;
  protected abstract indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void>;

  protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = (await this.vectorReady) || false;
    } catch (error) {
      const message = formatErrorMessage(error);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const resolvedPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath;
      this.vector.available = true;
      return true;
    } catch (error) {
      const message = formatErrorMessage(error);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions) {
      return;
    }
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (error) {
      const message = formatErrorMessage(error);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  protected buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = [...this.sources];
    if (sources.length === 0) {
      return { params: [], sql: "" };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { params: sources, sql: ` AND ${column} IN (${placeholders})` };
  }

  protected openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path);
    return openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled);
  }

  private seedEmbeddingCache(sourceDb: DatabaseSync): void {
    if (!this.cache.enabled) {
      return;
    }
    try {
      const rows = sourceDb
        .prepare(
          `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
        )
        .all() as {
        provider: string;
        model: string;
        provider_key: string;
        hash: string;
        embedding: string;
        dims: number | null;
        updated_at: number;
      }[];
      if (!rows.length) {
        return;
      }
      const insert = this.db.prepare(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
           embedding=excluded.embedding,
           dims=excluded.dims,
           updated_at=excluded.updated_at`,
      );
      this.db.exec("BEGIN");
      for (const row of rows) {
        insert.run(
          row.provider,
          row.model,
          row.provider_key,
          row.hash,
          row.embedding,
          row.dims,
          row.updated_at,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  protected ensureSchema() {
    const result = ensureMemoryIndexSchema({
      cacheEnabled: this.cache.enabled,
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsEnabled: this.fts.enabled,
      ftsTable: FTS_TABLE,
      ftsTokenizer: this.settings.store.fts.tokenizer,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      // Only warn when hybrid search is enabled; otherwise this is expected noise.
      if (this.fts.enabled) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    }
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) {
      return;
    }
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory", "**", "*.md"),
    ]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          watchPaths.add(path.join(entry, "**", "*.md"));
          if (this.settings.multimodal.enabled) {
            for (const modality of this.settings.multimodal.modalities) {
              for (const extension of getMemoryMultimodalExtensions(modality)) {
                watchPaths.add(
                  path.join(entry, "**", buildCaseInsensitiveExtensionGlob(extension)),
                );
              }
            }
          }
          continue;
        }
        if (
          stat.isFile() &&
          (normalizeLowercaseStringOrEmpty(entry).endsWith(".md") ||
            classifyMemoryMultimodalPath(entry, this.settings.multimodal) !== null)
        ) {
          watchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    this.watcher = chokidar.watch([...watchPaths], {
      awaitWriteFinish: {
        pollInterval: 100,
        stabilityThreshold: this.settings.sync.watchDebounceMs,
      },
      ignoreInitial: true,
      ignored: (watchPath) => shouldIgnoreMemoryWatchPath(String(watchPath)),
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      if (this.closed) {
        return;
      }
      const { sessionFile } = update;
      if (!this.isSessionFileForAgent(sessionFile)) {
        return;
      }
      this.scheduleSessionDirty(sessionFile);
    });
  }

  private scheduleSessionDirty(sessionFile: string) {
    this.sessionPendingFiles.add(sessionFile);
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void this.processSessionDeltaBatch().catch((error) => {
        log.warn(`memory session delta failed: ${String(error)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionDeltaBatch(): Promise<void> {
    if (this.sessionPendingFiles.size === 0) {
      return;
    }
    const pending = [...this.sessionPendingFiles];
    this.sessionPendingFiles.clear();
    let shouldSync = false;
    for (const sessionFile of pending) {
      const delta = await this.updateSessionDelta(sessionFile);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.sessionsDirtyFiles.add(sessionFile);
      this.sessionsDirty = true;
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((error) => {
        log.warn(`memory sync failed (session-delta): ${String(error)}`);
      });
    }
  }

  private async updateSessionDelta(sessionFile: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) {
      return null;
    }
    let stat: { size: number };
    try {
      stat = await fs.stat(sessionFile);
    } catch {
      return null;
    }
    const { size } = stat;
    let state = this.sessionDeltas.get(sessionFile);
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionFile, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize);
    if (deltaBytes === 0 && size === state.lastSize) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    if (size < state.lastSize) {
      state.lastSize = size;
      state.pendingBytes += size;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
      }
    } else {
      state.pendingBytes += deltaBytes;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
      }
      state.lastSize = size;
    }
    this.sessionDeltas.set(sessionFile, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  private async countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) {
      return 0;
    }
    let handle;
    try {
      handle = await fs.open(absPath, "r");
    } catch (error) {
      if (isFileMissingError(error)) {
        return 0;
      }
      throw error;
    }
    try {
      let offset = start;
      let count = 0;
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) {
          break;
        }
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) {
            count += 1;
          }
        }
        offset += bytesRead;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  private resetSessionDelta(absPath: string, size: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) {
      return false;
    }
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
    const resolvedFile = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  private normalizeTargetSessionFiles(sessionFiles?: string[]): Set<string> | null {
    if (!sessionFiles || sessionFiles.length === 0) {
      return null;
    }
    const normalized = new Set<string>();
    for (const sessionFile of sessionFiles) {
      const trimmed = sessionFile.trim();
      if (!trimmed) {
        continue;
      }
      const resolved = path.resolve(trimmed);
      if (this.isSessionFileForAgent(resolved)) {
        normalized.add(resolved);
      }
    }
    return normalized.size > 0 ? normalized : null;
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      runDetachedMemorySync(() => this.sync({ reason: "interval" }), "interval");
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      runDetachedMemorySync(() => this.sync({ reason: "watch" }), "watch");
    }, this.settings.sync.watchDebounceMs);
  }

  private shouldSyncSessions(
    params?: { reason?: string; force?: boolean; sessionFiles?: string[] },
    needsFullReindex = false,
  ) {
    return shouldSyncSessionsForReindex({
      dirtySessionFileCount: this.sessionsDirtyFiles.size,
      hasSessionSource: this.sources.has("sessions"),
      needsFullReindex,
      sessionsDirty: this.sessionsDirty,
      sync: params,
    });
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    const deleteFileByPathAndSource = this.db.prepare(
      `DELETE FROM files WHERE path = ? AND source = ?`,
    );
    const deleteChunksByPathAndSource = this.db.prepare(
      `DELETE FROM chunks WHERE path = ? AND source = ?`,
    );
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
        : null;
    const deleteFtsRowsByPathAndSource =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ?`)
        : null;

    const files = await listMemoryFiles(
      this.workspaceDir,
      this.settings.extraPaths,
      this.settings.multimodal,
    );
    const fileEntries = (
      await runWithConcurrency(
        files.map(
          (file) => async () =>
            await buildFileEntry(file, this.workspaceDir, this.settings.multimodal),
        ),
        this.getIndexConcurrency(),
      )
    ).filter((entry): entry is MemoryFileEntry => entry !== null);
    log.debug("memory sync: indexing memory files", {
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
    });
    const existingState = loadMemorySourceFileState({
      db: this.db,
      source: "memory",
    });
    const existingRows = existingState.rows;
    const existingHashes = existingState.hashes;
    const activePaths = new Set(fileEntries.map((entry) => entry.path));
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
        total: params.progress.total,
      });
    }

    const tasks = fileEntries.map((entry) => async () => {
      if (!params.needsFullReindex && existingHashes.get(entry.path) === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      await this.indexFile(entry, { source: "memory" });
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    for (const stale of existingRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      deleteFileByPathAndSource.run(stale.path, "memory");
      if (deleteVectorRowsByPathAndSource) {
        try {
          deleteVectorRowsByPathAndSource.run(stale.path, "memory");
        } catch {}
      }
      deleteChunksByPathAndSource.run(stale.path, "memory");
      if (deleteFtsRowsByPathAndSource) {
        try {
          deleteFtsRowsByPathAndSource.run(stale.path, "memory");
        } catch {}
      }
    }
  }

  private async syncSessionFiles(params: {
    needsFullReindex: boolean;
    targetSessionFiles?: string[];
    progress?: MemorySyncProgressState;
  }) {
    const deleteFileByPathAndSource = this.db.prepare(
      `DELETE FROM files WHERE path = ? AND source = ?`,
    );
    const deleteChunksByPathAndSource = this.db.prepare(
      `DELETE FROM chunks WHERE path = ? AND source = ?`,
    );
    const deleteVectorRowsByPathAndSource =
      this.vector.enabled && this.vector.available
        ? this.db.prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
        : null;
    const deleteFtsRowsByPathSourceAndModel =
      this.fts.enabled && this.fts.available
        ? this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
        : null;

    const targetSessionFiles = params.needsFullReindex
      ? null
      : this.normalizeTargetSessionFiles(params.targetSessionFiles);
    const files = targetSessionFiles
      ? [...targetSessionFiles]
      : await listSessionFilesForAgent(this.agentId);
    const sessionPlan = resolveMemorySessionSyncPlan({
      existingRows: targetSessionFiles
        ? null
        : loadMemorySourceFileState({
            db: this.db,
            source: "sessions",
          }).rows,
      files,
      needsFullReindex: params.needsFullReindex,
      sessionPathForFile,
      sessionsDirtyFiles: this.sessionsDirtyFiles,
      targetSessionFiles,
    });
    const { activePaths, existingRows, existingHashes, indexAll } = sessionPlan;
    log.debug("memory sync: indexing session files", {
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
      dirtyFiles: this.sessionsDirtyFiles.size,
      files: files.length,
      indexAll,
      targetedFiles: targetSessionFiles?.size ?? 0,
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        label: this.batch.enabled ? "Indexing session files (batch)..." : "Indexing session files…",
        total: params.progress.total,
      });
    }

    const tasks = files.map((absPath) => async () => {
      if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const entry = await buildSessionEntry(absPath);
      if (!entry) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      const existingHash = resolveMemorySourceExistingHash({
        db: this.db,
        existingHashes,
        path: entry.path,
        source: "sessions",
      });
      if (!params.needsFullReindex && existingHash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        this.resetSessionDelta(absPath, entry.size);
        return;
      }
      await this.indexFile(entry, { content: entry.content, source: "sessions" });
      this.resetSessionDelta(absPath, entry.size);
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    if (activePaths === null) {
      // Targeted syncs only refresh the requested transcripts and should not
      // Prune unrelated session rows without a full directory enumeration.
      return;
    }

    for (const stale of existingRows ?? []) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      deleteFileByPathAndSource.run(stale.path, "sessions");
      if (deleteVectorRowsByPathAndSource) {
        try {
          deleteVectorRowsByPathAndSource.run(stale.path, "sessions");
        } catch {}
      }
      deleteChunksByPathAndSource.run(stale.path, "sessions");
      if (deleteFtsRowsByPathSourceAndModel) {
        try {
          deleteFtsRowsByPathSourceAndModel.run(
            stale.path,
            "sessions",
            this.provider?.model ?? "fts-only",
          );
        } catch {}
      }
    }
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          label,
          total: update.total,
        });
      },
      total: 0,
    };
    return state;
  }

  protected async runSync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        label: "Loading vector extension…",
        total: progress.total,
      });
    }
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const configuredSources = resolveConfiguredSourcesForMeta(this.sources);
    const configuredScopeHash = resolveConfiguredScopeHash({
      extraPaths: this.settings.extraPaths,
      multimodal: {
        enabled: this.settings.multimodal.enabled,
        maxFileBytes: this.settings.multimodal.maxFileBytes,
        modalities: this.settings.multimodal.modalities,
      },
      workspaceDir: this.workspaceDir,
    });
    const targetSessionFiles = this.normalizeTargetSessionFiles(params?.sessionFiles);
    const hasTargetSessionFiles = targetSessionFiles !== null;
    const targetedSessionSync = await runMemoryTargetedSessionSync({
      activateFallbackProvider: async (reason) => await this.activateFallbackProvider(reason),
      hasSessionSource: this.sources.has("sessions"),
      progress: progress ?? undefined,
      reason: params?.reason,
      runSafeReindex: async (reindexParams) => {
        await this.runSafeReindex(reindexParams);
      },
      runUnsafeReindex: async (reindexParams) => {
        await this.runUnsafeReindex(reindexParams);
      },
      sessionsDirtyFiles: this.sessionsDirtyFiles,
      shouldFallbackOnError: (message) => this.shouldFallbackOnError(message),
      syncSessionFiles: async (targetedParams) => {
        await this.syncSessionFiles(targetedParams);
      },
      targetSessionFiles,
      useUnsafeReindex:
        process.env.OPENCLAW_TEST_FAST === "1" &&
        process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1",
    });
    if (targetedSessionSync.handled) {
      this.sessionsDirty = targetedSessionSync.sessionsDirty;
      return;
    }
    const needsFullReindex =
      (params?.force && !hasTargetSessionFiles) ||
      shouldRunFullMemoryReindex({
        meta,
        // Also detects provider→FTS-only transitions so orphaned old-model FTS rows are cleaned up.
        provider: this.provider ? { id: this.provider.id, model: this.provider.model } : null,
        providerKey: this.providerKey ?? undefined,
        configuredSources,
        configuredScopeHash,
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
        vectorReady,
        ftsTokenizer: this.settings.store.fts.tokenizer,
      });
    try {
      if (needsFullReindex) {
        if (
          process.env.OPENCLAW_TEST_FAST === "1" &&
          process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1"
        ) {
          await this.runUnsafeReindex({
            force: params?.force,
            progress: progress ?? undefined,
            reason: params?.reason,
          });
        } else {
          await this.runSafeReindex({
            force: params?.force,
            progress: progress ?? undefined,
            reason: params?.reason,
          });
        }
        return;
      }

      const shouldSyncMemory =
        this.sources.has("memory") &&
        ((!hasTargetSessionFiles && params?.force) || needsFullReindex || this.dirty);
      const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
        this.dirty = false;
      }

      if (shouldSyncSessions) {
        await this.syncSessionFiles({
          needsFullReindex,
          progress: progress ?? undefined,
          targetSessionFiles: targetSessionFiles ? [...targetSessionFiles] : undefined,
        });
        this.sessionsDirty = false;
        this.sessionsDirtyFiles.clear();
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }
    } catch (error) {
      const reason = formatErrorMessage(error);
      const activated =
        this.shouldFallbackOnError(reason) && (await this.activateFallbackProvider(reason));
      if (activated) {
        await this.runSafeReindex({
          force: true,
          progress: progress ?? undefined,
          reason: params?.reason ?? "fallback",
        });
        return;
      }
      throw error;
    }
  }

  private shouldFallbackOnError(message: string): boolean {
    return /embedding|embeddings|batch/i.test(message);
  }

  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.settings.remote?.batch;
    const enabled = Boolean(batch?.enabled && this.provider && this.providerRuntime?.batchEmbed);
    return {
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      enabled,
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
      wait: batch?.wait ?? true,
    };
  }

  private async activateFallbackProvider(reason: string): Promise<boolean> {
    const fallbackRequest = resolveMemoryFallbackProviderRequest({
      cfg: this.cfg,
      currentProviderId: this.provider?.id ?? null,
      settings: this.settings,
    });
    if (!fallbackRequest || !this.provider) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }
    const fallbackFrom = this.provider.id;

    const fallbackResult = await createEmbeddingProvider({
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      config: this.cfg,
      ...fallbackRequest,
    });

    const fallbackState = applyMemoryFallbackProviderState({
      current: {
        fallbackFrom: this.fallbackFrom,
        fallbackReason: this.fallbackReason,
        provider: this.provider,
        providerRuntime: this.providerRuntime,
        providerUnavailableReason: undefined,
      },
      fallbackFrom,
      reason,
      result: fallbackResult,
    });
    this.fallbackFrom = fallbackState.fallbackFrom;
    this.fallbackReason = fallbackState.fallbackReason;
    this.provider = fallbackState.provider;
    this.providerRuntime = fallbackState.providerRuntime;
    this.providerKey = this.computeProviderKey();
    this.batch = this.resolveBatchConfig();
    log.warn(`memory embeddings: switched to fallback provider (${fallbackRequest.provider})`, {
      reason,
    });
    return true;
  }

  private async runSafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    const dbPath = resolveUserPath(this.settings.store.path);
    const tempDbPath = `${dbPath}.tmp-${randomUUID()}`;
    const tempDb = openMemoryDatabaseAtPath(tempDbPath, this.settings.store.vector.enabled);

    const originalDb = this.db;
    let originalDbClosed = false;
    const originalState = {
      ftsAvailable: this.fts.available,
      ftsError: this.fts.loadError,
      vectorAvailable: this.vector.available,
      vectorDims: this.vector.dims,
      vectorLoadError: this.vector.loadError,
      vectorReady: this.vectorReady,
    };

    const restoreOriginalState = () => {
      if (originalDbClosed) {
        this.db = openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled);
      } else {
        this.db = originalDb;
      }
      this.fts.available = originalState.ftsAvailable;
      this.fts.loadError = originalState.ftsError;
      this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
      this.vector.loadError = originalState.vectorLoadError;
      this.vector.dims = originalState.vectorDims;
      this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
    };

    this.db = tempDb;
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.fts.available = false;
    this.fts.loadError = undefined;
    this.ensureSchema();

    let nextMeta: MemoryIndexMeta | null = null;

    try {
      nextMeta = await runMemoryAtomicReindex({
        build: async () => {
          this.seedEmbeddingCache(originalDb);
          const shouldSyncMemory = this.sources.has("memory");
          const shouldSyncSessions = this.shouldSyncSessions(
            { force: params.force, reason: params.reason },
            true,
          );

          if (shouldSyncMemory) {
            await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
            this.dirty = false;
          }

          if (shouldSyncSessions) {
            await this.syncSessionFiles({ needsFullReindex: true, progress: params.progress });
            this.sessionsDirty = false;
            this.sessionsDirtyFiles.clear();
          } else if (this.sessionsDirtyFiles.size > 0) {
            this.sessionsDirty = true;
          } else {
            this.sessionsDirty = false;
          }

          const meta: MemoryIndexMeta = {
            chunkOverlap: this.settings.chunking.overlap,
            chunkTokens: this.settings.chunking.tokens,
            ftsTokenizer: this.settings.store.fts.tokenizer,
            model: this.provider?.model ?? "fts-only",
            provider: this.provider?.id ?? "none",
            providerKey: this.providerKey!,
            scopeHash: resolveConfiguredScopeHash({
              workspaceDir: this.workspaceDir,
              extraPaths: this.settings.extraPaths,
              multimodal: {
                enabled: this.settings.multimodal.enabled,
                modalities: this.settings.multimodal.modalities,
                maxFileBytes: this.settings.multimodal.maxFileBytes,
              },
            }),
            sources: resolveConfiguredSourcesForMeta(this.sources),
          };

          if (this.vector.available && this.vector.dims) {
            meta.vectorDims = this.vector.dims;
          }

          this.writeMeta(meta);
          this.pruneEmbeddingCacheIfNeeded?.();

          this.db.close();
          originalDb.close();
          originalDbClosed = true;
          return meta;
        },
        targetPath: dbPath,
        tempPath: tempDbPath,
      });

      this.db = openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled);
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema();
      this.vector.dims = nextMeta?.vectorDims;
    } catch (error) {
      try {
        this.db.close();
      } catch {}
      restoreOriginalState();
      throw error;
    }
  }

  private async runUnsafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    // Perf: for test runs, skip atomic temp-db swapping. The index is isolated
    // Under the per-test HOME anyway, and this cuts substantial fs+sqlite churn.
    this.resetIndex();

    const shouldSyncMemory = this.sources.has("memory");
    const shouldSyncSessions = this.shouldSyncSessions(
      { force: params.force, reason: params.reason },
      true,
    );

    if (shouldSyncMemory) {
      await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
      this.dirty = false;
    }

    if (shouldSyncSessions) {
      await this.syncSessionFiles({ needsFullReindex: true, progress: params.progress });
      this.sessionsDirty = false;
      this.sessionsDirtyFiles.clear();
    } else if (this.sessionsDirtyFiles.size > 0) {
      this.sessionsDirty = true;
    } else {
      this.sessionsDirty = false;
    }

    const nextMeta: MemoryIndexMeta = {
      chunkOverlap: this.settings.chunking.overlap,
      chunkTokens: this.settings.chunking.tokens,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      model: this.provider?.model ?? "fts-only",
      provider: this.provider?.id ?? "none",
      providerKey: this.providerKey!,
      scopeHash: resolveConfiguredScopeHash({
        extraPaths: this.settings.extraPaths,
        multimodal: {
          enabled: this.settings.multimodal.enabled,
          maxFileBytes: this.settings.multimodal.maxFileBytes,
          modalities: this.settings.multimodal.modalities,
        },
        workspaceDir: this.workspaceDir,
      }),
      sources: resolveConfiguredSourcesForMeta(this.sources),
    };
    if (this.vector.available && this.vector.dims) {
      nextMeta.vectorDims = this.vector.dims;
    }

    this.writeMeta(nextMeta);
    this.pruneEmbeddingCacheIfNeeded?.();
  }

  private resetIndex() {
    this.db.exec(`DELETE FROM files`);
    this.db.exec(`DELETE FROM chunks`);
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`);
      } catch {}
    }
    this.ensureSchema();
    this.dropVectorTable();
    this.vector.dims = undefined;
    this.sessionsDirtyFiles.clear();
  }

  protected readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) {
      this.lastMetaSerialized = null;
      return null;
    }
    try {
      const parsed = JSON.parse(row.value) as MemoryIndexMeta;
      this.lastMetaSerialized = row.value;
      return parsed;
    } catch {
      this.lastMetaSerialized = null;
      return null;
    }
  }

  protected writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    if (this.lastMetaSerialized === value) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
    this.lastMetaSerialized = value;
  }
}
