import fs from "node:fs";
import path from "node:path";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import { type SessionDiskBudgetSweepResult, enforceSessionDiskBudget } from "./disk-budget.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  dropSessionStoreObjectCache,
  getSerializedSessionStore,
  isSessionStoreCacheEnabled,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { loadSessionStore, normalizeSessionStore } from "./store-load.js";
import {
  LOCK_QUEUES,
  type SessionStoreLockQueue,
  type SessionStoreLockTask,
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
  getSessionStoreLockQueueSizeForTest,
} from "./store-lock-state.js";
import {
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  rotateSessionFile,
} from "./store-maintenance.js";
import {
  type SessionEntry,
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
} from "./types.js";

export {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
  getSessionStoreLockQueueSizeForTest,
} from "./store-lock-state.js";
export { loadSessionStore } from "./store-load.js";

const log = createSubsystemLogger("sessions/store");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;
let sessionWriteLockAcquirerForTests: typeof acquireSessionWriteLock | null = null;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export function normalizeStoreSessionKey(sessionKey: string): string {
  return normalizeLowercaseStringOrEmpty(sessionKey);
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const trimmedKey = params.sessionKey.trim();
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const legacyKeySet = new Set<string>();
  if (trimmedKey !== normalizedKey && Object.hasOwn(params.store, trimmedKey)) {
    legacyKeySet.add(trimmedKey);
  }
  let existing =
    params.store[normalizedKey] ?? (legacyKeySet.size > 0 ? params.store[trimmedKey] : undefined);
  let existingUpdatedAt = existing?.updatedAt ?? 0;
  for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
    if (candidateKey === normalizedKey) {
      continue;
    }
    if (normalizeStoreSessionKey(candidateKey) !== normalizedKey) {
      continue;
    }
    legacyKeySet.add(candidateKey);
    const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
    if (!existing || candidateUpdatedAt > existingUpdatedAt) {
      existing = candidateEntry;
      existingUpdatedAt = candidateUpdatedAt;
    }
  }
  return {
    existing,
    legacyKeys: [...legacyKeySet],
    normalizedKey,
  };
}

export function setSessionWriteLockAcquirerForTests(
  acquirer: typeof acquireSessionWriteLock | null,
): void {
  sessionWriteLockAcquirerForTests = acquirer;
}

export function resetSessionStoreLockRuntimeForTests(): void {
  sessionWriteLockAcquirerForTests = null;
}

export async function withSessionStoreLockForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  return await withSessionStoreLock(storePath, fn, opts);
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStore(params.storePath);
    const resolved = resolveSessionStoreEntry({ sessionKey: params.sessionKey, store });
    return resolved.existing?.updatedAt;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Session Store Pruning, Capping & File Rotation
// ============================================================================

export interface SessionMaintenanceApplyReport {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
}

export {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  rotateSessionFile,
};
export type { ResolvedSessionMaintenanceConfig, SessionMaintenanceWarning };

interface SaveSessionStoreOptions {
  /** Skip pruning, capping, and rotation (e.g. during one-time migrations). */
  skipMaintenance?: boolean;
  /** Active session key for warn-only maintenance. */
  activeSessionKey?: string;
  /**
   * Session keys that are allowed to drop persisted ACP metadata during this update.
   * All other updates preserve existing `entry.acp` blocks when callers replace the
   * whole session entry without carrying ACP state forward.
   */
  allowDropAcpMetaSessionKeys?: string[];
  /** Optional callback for warn-only maintenance. */
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  /** Optional callback with maintenance stats after a save. */
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  /** Optional overrides used by maintenance commands. */
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
}

function updateSessionStoreWriteCaches(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): void {
  const fileStat = getFileStatSnapshot(params.storePath);
  setSerializedSessionStore(params.storePath, params.serialized);
  if (!isSessionStoreCacheEnabled()) {
    dropSessionStoreObjectCache(params.storePath);
    return;
  }
  writeSessionStoreCache({
    mtimeMs: fileStat?.mtimeMs,
    serialized: params.serialized,
    sizeBytes: fileStat?.sizeBytes,
    store: params.store,
    storePath: params.storePath,
  });
}

function resolveMutableSessionStoreKey(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): string | undefined {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.hasOwn(store, trimmed)) {
    return trimmed;
  }
  const normalized = normalizeStoreSessionKey(trimmed);
  if (Object.hasOwn(store, normalized)) {
    return normalized;
  }
  return Object.keys(store).find((key) => normalizeStoreSessionKey(key) === normalized);
}

function collectAcpMetadataSnapshot(
  store: Record<string, SessionEntry>,
): Map<string, NonNullable<SessionEntry["acp"]>> {
  const snapshot = new Map<string, NonNullable<SessionEntry["acp"]>>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (entry?.acp) {
      snapshot.set(sessionKey, entry.acp);
    }
  }
  return snapshot;
}

function preserveExistingAcpMetadata(params: {
  previousAcpByKey: Map<string, NonNullable<SessionEntry["acp"]>>;
  nextStore: Record<string, SessionEntry>;
  allowDropSessionKeys?: string[];
}): void {
  const allowDrop = new Set(
    (params.allowDropSessionKeys ?? []).map((key) => normalizeStoreSessionKey(key)),
  );
  for (const [previousKey, previousAcp] of params.previousAcpByKey.entries()) {
    const normalizedKey = normalizeStoreSessionKey(previousKey);
    if (allowDrop.has(normalizedKey)) {
      continue;
    }
    const nextKey = resolveMutableSessionStoreKey(params.nextStore, previousKey);
    if (!nextKey) {
      continue;
    }
    const nextEntry = params.nextStore[nextKey];
    if (!nextEntry || nextEntry.acp) {
      continue;
    }
    params.nextStore[nextKey] = {
      ...nextEntry,
      acp: previousAcp,
    };
  }
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  normalizeSessionStore(store);

  if (!opts?.skipMaintenance) {
    // Resolve maintenance config once (avoids repeated loadConfig() calls).
    const maintenance = { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
    const shouldWarnOnly = maintenance.mode === "warn";
    const beforeCount = Object.keys(store).length;

    if (shouldWarnOnly) {
      const activeSessionKey = opts?.activeSessionKey?.trim();
      if (activeSessionKey) {
        const warning = getActiveSessionMaintenanceWarning({
          activeSessionKey,
          maxEntries: maintenance.maxEntries,
          pruneAfterMs: maintenance.pruneAfterMs,
          store,
        });
        if (warning) {
          log.warn("session maintenance would evict active session; skipping enforcement", {
            activeSessionKey: warning.activeSessionKey,
            maxEntries: warning.maxEntries,
            pruneAfterMs: warning.pruneAfterMs,
            wouldCap: warning.wouldCap,
            wouldPrune: warning.wouldPrune,
          });
          await opts?.onWarn?.(warning);
        }
      }
      const diskBudget = await enforceSessionDiskBudget({
        activeSessionKey: opts?.activeSessionKey,
        log,
        maintenance,
        store,
        storePath,
        warnOnly: true,
      });
      await opts?.onMaintenanceApplied?.({
        afterCount: Object.keys(store).length,
        beforeCount,
        capped: 0,
        diskBudget,
        mode: maintenance.mode,
        pruned: 0,
      });
    } else {
      // Prune stale entries and cap total count before serializing.
      const removedSessionFiles = new Map<string, string | undefined>();
      const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
        onPruned: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
      });
      const capped = capEntryCount(store, maintenance.maxEntries, {
        onCapped: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
      });
      const archivedDirs = new Set<string>();
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedForDeletedSessions = await archiveRemovedSessionTranscripts({
        reason: "deleted",
        referencedSessionIds,
        removedSessionFiles,
        restrictToStoreDir: true,
        storePath,
      });
      for (const archivedDir of archivedForDeletedSessions) {
        archivedDirs.add(archivedDir);
      }
      if (archivedDirs.size > 0 || maintenance.resetArchiveRetentionMs != null) {
        const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
        const targetDirs =
          archivedDirs.size > 0 ? [...archivedDirs] : [path.dirname(path.resolve(storePath))];
        await cleanupArchivedSessionTranscripts({
          directories: targetDirs,
          olderThanMs: maintenance.pruneAfterMs,
          reason: "deleted",
        });
        if (maintenance.resetArchiveRetentionMs != null) {
          await cleanupArchivedSessionTranscripts({
            directories: targetDirs,
            olderThanMs: maintenance.resetArchiveRetentionMs,
            reason: "reset",
          });
        }
      }

      // Rotate the on-disk file if it exceeds the size threshold.
      await rotateSessionFile(storePath, maintenance.rotateBytes);

      const diskBudget = await enforceSessionDiskBudget({
        activeSessionKey: opts?.activeSessionKey,
        log,
        maintenance,
        store,
        storePath,
        warnOnly: false,
      });
      await opts?.onMaintenanceApplied?.({
        afterCount: Object.keys(store).length,
        beforeCount,
        capped,
        diskBudget,
        mode: maintenance.mode,
        pruned,
      });
    }
  }

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);
  if (getSerializedSessionStore(storePath) === json) {
    updateSessionStoreWriteCaches({ serialized: json, store, storePath });
    return;
  }

  // Windows: keep retry semantics because rename can fail while readers hold locks.
  if (process.platform === "win32") {
    for (let i = 0; i < 5; i++) {
      try {
        await writeSessionStoreAtomic({ serialized: json, store, storePath });
        return;
      } catch (error) {
        const code = getErrorCode(error);
        if (code === "ENOENT") {
          return;
        }
        if (i < 4) {
          await new Promise((r) => setTimeout(r, 50 * (i + 1)));
          continue;
        }
        // Final attempt failed — skip this save. The write lock ensures
        // The next save will retry with fresh data. Log for diagnostics.
        log.warn(`atomic write failed after 5 attempts: ${storePath}`);
      }
    }
    return;
  }

  try {
    await writeSessionStoreAtomic({ serialized: json, store, storePath });
  } catch (error) {
    const code = getErrorCode(error);

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await writeSessionStoreAtomic({ serialized: json, store, storePath });
      } catch (error) {
        const code2 = getErrorCode(error);
        if (code2 === "ENOENT") {
          return;
        }
        throw error;
      }
      return;
    }

    throw error;
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  await withSessionStoreLock(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store, opts);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts?: SaveSessionStoreOptions,
): Promise<T> {
  return await withSessionStoreLock(storePath, async () => {
    // Always re-read inside the lock to avoid clobbering concurrent writers.
    const store = loadSessionStore(storePath, { skipCache: true });
    const previousAcpByKey = collectAcpMetadataSnapshot(store);
    const result = await mutator(store);
    preserveExistingAcpMetadata({
      allowDropSessionKeys: opts?.allowDropAcpMetaSessionKeys,
      nextStore: store,
      previousAcpByKey,
    });
    await saveSessionStoreUnlocked(storePath, store, opts);
    return result;
  });
}

interface SessionStoreLockOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
}

const SESSION_STORE_LOCK_MIN_HOLD_MS = 5000;
const SESSION_STORE_LOCK_TIMEOUT_GRACE_MS = 5000;

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return String((error as { code?: unknown }).code);
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

export async function archiveRemovedSessionTranscripts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  reason: "deleted" | "reset";
  restrictToStoreDir?: boolean;
}): Promise<Set<string>> {
  const { archiveSessionTranscripts } = await loadSessionArchiveRuntime();
  const archivedDirs = new Set<string>();
  for (const [sessionId, sessionFile] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    const archived = archiveSessionTranscripts({
      reason: params.reason,
      restrictToStoreDir: params.restrictToStoreDir,
      sessionFile,
      sessionId,
      storePath: params.storePath,
    });
    for (const archivedPath of archived) {
      archivedDirs.add(path.dirname(archivedPath));
    }
  }
  return archivedDirs;
}

async function writeSessionStoreAtomic(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  serialized: string;
}): Promise<void> {
  await writeTextAtomic(params.storePath, params.serialized, { mode: 0o600 });
  updateSessionStoreWriteCaches({
    serialized: params.serialized,
    store: params.store,
    storePath: params.storePath,
  });
}

async function persistResolvedSessionEntry(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  resolved: ReturnType<typeof resolveSessionStoreEntry>;
  next: SessionEntry;
}): Promise<SessionEntry> {
  params.store[params.resolved.normalizedKey] = params.next;
  for (const legacyKey of params.resolved.legacyKeys) {
    delete params.store[legacyKey];
  }
  await saveSessionStoreUnlocked(params.storePath, params.store, {
    activeSessionKey: params.resolved.normalizedKey,
  });
  return params.next;
}

function lockTimeoutError(storePath: string): Error {
  return new Error(`timeout waiting for session store lock: ${storePath}`);
}

function resolveSessionStoreLockMaxHoldMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return resolveSessionLockMaxHoldFromTimeout({
    graceMs: SESSION_STORE_LOCK_TIMEOUT_GRACE_MS,
    minMs: SESSION_STORE_LOCK_MIN_HOLD_MS,
    timeoutMs,
  });
}

function getOrCreateLockQueue(storePath: string): SessionStoreLockQueue {
  const existing = LOCK_QUEUES.get(storePath);
  if (existing) {
    return existing;
  }
  const created: SessionStoreLockQueue = { drainPromise: null, pending: [], running: false };
  LOCK_QUEUES.set(storePath, created);
  return created;
}

async function drainSessionStoreLockQueue(storePath: string): Promise<void> {
  const queue = LOCK_QUEUES.get(storePath);
  if (!queue) {
    return;
  }
  if (queue.drainPromise) {
    await queue.drainPromise;
    return;
  }
  queue.running = true;
  queue.drainPromise = (async () => {
    try {
      while (queue.pending.length > 0) {
        const task = queue.pending.shift();
        if (!task) {
          continue;
        }

        const remainingTimeoutMs = task.timeoutMs ?? Number.POSITIVE_INFINITY;
        if (task.timeoutMs != null && remainingTimeoutMs <= 0) {
          task.reject(lockTimeoutError(storePath));
          continue;
        }

        let lock: { release: () => Promise<void> } | undefined;
        let result: unknown;
        let failed: unknown;
        let hasFailure = false;
        try {
          lock = await (sessionWriteLockAcquirerForTests ?? acquireSessionWriteLock)({
            maxHoldMs: resolveSessionStoreLockMaxHoldMs(task.timeoutMs),
            sessionFile: storePath,
            staleMs: task.staleMs,
            timeoutMs: remainingTimeoutMs,
          });
          result = await task.fn();
        } catch (error) {
          hasFailure = true;
          failed = error;
        } finally {
          await lock?.release().catch(() => undefined);
        }
        if (hasFailure) {
          task.reject(failed);
          continue;
        }
        task.resolve(result);
      }
    } finally {
      queue.running = false;
      queue.drainPromise = null;
      if (queue.pending.length === 0) {
        LOCK_QUEUES.delete(storePath);
      } else {
        queueMicrotask(() => {
          void drainSessionStoreLockQueue(storePath);
        });
      }
    }
  })();
  await queue.drainPromise;
}

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  if (!storePath || typeof storePath !== "string") {
    throw new Error(
      `withSessionStoreLock: storePath must be a non-empty string, got ${JSON.stringify(storePath)}`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  // `pollIntervalMs` is retained for API compatibility with older lock options.
  void opts.pollIntervalMs;

  const hasTimeout = timeoutMs > 0 && Number.isFinite(timeoutMs);
  const queue = getOrCreateLockQueue(storePath);

  const promise = new Promise<T>((resolve, reject) => {
    const task: SessionStoreLockTask = {
      fn: async () => await fn(),
      reject,
      resolve: (value) => resolve(value as T),
      staleMs,
      timeoutMs: hasTimeout ? timeoutMs : undefined,
    };

    queue.pending.push(task);
    void drainSessionStoreLockQueue(storePath);
  });

  return await promise;
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath, { skipCache: true });
    const resolved = resolveSessionStoreEntry({ sessionKey, store });
    const { existing } = resolved;
    if (!existing) {
      return null;
    }
    const patch = await update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    return await persistResolvedSessionEntry({
      next,
      resolved,
      store,
      storePath,
    });
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await updateSessionStore(
    storePath,
    (store) => {
      const resolved = resolveSessionStoreEntry({ sessionKey, store });
      const { existing } = resolved;
      const patch = deriveSessionMetaPatch({
        ctx,
        existing,
        groupResolution: params.groupResolution,
        sessionKey: resolved.normalizedKey,
      });
      if (!patch) {
        if (existing && resolved.legacyKeys.length > 0) {
          store[resolved.normalizedKey] = existing;
          for (const legacyKey of resolved.legacyKeys) {
            delete store[legacyKey];
          }
        }
        return existing ?? null;
      }
      if (!existing && !createIfMissing) {
        return null;
      }
      const next = existing
        ? // Inbound metadata updates must not refresh activity timestamps;
          // Idle reset evaluation relies on updatedAt from actual session turns.
          mergeSessionEntryPreserveActivity(existing, patch)
        : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
      return next;
    },
    { activeSessionKey: normalizeStoreSessionKey(sessionKey) },
  );
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
}) {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const resolved = resolveSessionStoreEntry({ sessionKey, store });
    const { existing } = resolved;
    const now = Date.now();
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      accountId,
      channel,
      threadId,
      to,
    });
    const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
    const explicitDeliveryContext = params.deliveryContext;
    const explicitThreadFromDeliveryContext =
      explicitDeliveryContext != null && Object.hasOwn(explicitDeliveryContext, "threadId")
        ? explicitDeliveryContext.threadId
        : undefined;
    const explicitThreadValue =
      explicitThreadFromDeliveryContext ??
      (threadId != null && threadId !== "" ? threadId : undefined);
    const explicitRouteProvided = Boolean(
      explicitContext?.channel ||
      explicitContext?.to ||
      inlineContext?.channel ||
      inlineContext?.to,
    );
    const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
    const fallbackContext = clearThreadFromFallback
      ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
      : deliveryContextFromSession(existing);
    const merged = mergeDeliveryContext(mergedInput, fallbackContext);
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        accountId: merged?.accountId,
        channel: merged?.channel,
        threadId: merged?.threadId,
        to: merged?.to,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          existing,
          groupResolution: params.groupResolution,
          sessionKey: resolved.normalizedKey,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      deliveryContext: normalized.deliveryContext,
      lastAccountId: normalized.lastAccountId,
      lastChannel: normalized.lastChannel,
      lastThreadId: normalized.lastThreadId,
      lastTo: normalized.lastTo,
      updatedAt: Math.max(existing?.updatedAt ?? 0, now),
    };
    const next = mergeSessionEntry(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    return await persistResolvedSessionEntry({
      next,
      resolved,
      store,
      storePath,
    });
  });
}
