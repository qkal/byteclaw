import type { OpenClawConfig } from "../../config/config.js";
import { formatErrorMessage } from "../errors.js";
import {
  type QueuedDelivery,
  type QueuedDeliveryPayload,
  ackDelivery,
  failDelivery,
  loadPendingDeliveries,
  loadPendingDelivery,
  moveToFailed,
} from "./delivery-queue-storage.js";

export interface RecoverySummary {
  recovered: number;
  failed: number;
  skippedMaxRetries: number;
  deferredBackoff: number;
}

export type DeliverFn = (
  params: {
    cfg: OpenClawConfig;
  } & QueuedDeliveryPayload & {
      skipQueue?: boolean;
    },
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface PendingDeliveryDrainDecision {
  match: boolean;
  bypassBackoff?: boolean;
}

const MAX_RETRIES = 5;

/** Backoff delays in milliseconds indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5000, // Retry 1: 5s
  25_000, // Retry 2: 25s
  120_000, // Retry 3: 2m
  600_000, // Retry 4: 10m
];

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous .* recipient/i,
  /User .* not in room/i,
];

const drainInProgress = new Map<string, boolean>();
const entriesInProgress = new Set<string>();

type DeliverRuntimeModule = typeof import("./deliver-runtime.js");

let deliverRuntimePromise: Promise<DeliverRuntimeModule> | null = null;

function loadDeliverRuntime() {
  deliverRuntimePromise ??= import("./deliver-runtime.js");
  return deliverRuntimePromise;
}

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

function createEmptyRecoverySummary(): RecoverySummary {
  return {
    deferredBackoff: 0,
    failed: 0,
    recovered: 0,
    skippedMaxRetries: 0,
  };
}

function claimRecoveryEntry(entryId: string): boolean {
  if (entriesInProgress.has(entryId)) {
    return false;
  }
  entriesInProgress.add(entryId);
  return true;
}

function releaseRecoveryEntry(entryId: string): void {
  entriesInProgress.delete(entryId);
}

function buildRecoveryDeliverParams(entry: QueuedDelivery, cfg: OpenClawConfig) {
  return {
    accountId: entry.accountId,
    bestEffort: entry.bestEffort,
    cfg,
    channel: entry.channel,
    forceDocument: entry.forceDocument,
    gatewayClientScopes: entry.gatewayClientScopes,
    gifPlayback: entry.gifPlayback,
    mirror: entry.mirror,
    payloads: entry.payloads,
    replyToId: entry.replyToId,
    silent: entry.silent,
    skipQueue: true,
    threadId: entry.threadId,
    to: entry.to, // Prevent re-enqueueing during recovery.
  } satisfies Parameters<DeliverFn>[0];
}

async function moveEntryToFailedWithLogging(
  entryId: string,
  log: RecoveryLogger,
  stateDir?: string,
): Promise<void> {
  try {
    await moveToFailed(entryId, stateDir);
  } catch (error) {
    log.error(`Failed to move entry ${entryId} to failed/: ${String(error)}`);
  }
}

async function deferRemainingEntriesForBudget(
  entries: readonly QueuedDelivery[],
  stateDir: string | undefined,
): Promise<void> {
  // Increment retryCount so entries that are repeatedly deferred by the
  // Recovery budget eventually hit MAX_RETRIES and get pruned.
  await Promise.allSettled(
    entries.map((entry) => failDelivery(entry.id, "recovery time budget exceeded", stateDir)),
  );
}

/** Compute the backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

export function isEntryEligibleForRecoveryRetry(
  entry: QueuedDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  const backoff = computeBackoffMs(entry.retryCount + 1);
  if (backoff <= 0) {
    return { eligible: true };
  }
  const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
  if (firstReplayAfterCrash) {
    return { eligible: true };
  }
  const hasAttemptTimestamp =
    typeof entry.lastAttemptAt === "number" &&
    Number.isFinite(entry.lastAttemptAt) &&
    entry.lastAttemptAt > 0;
  const baseAttemptAt = hasAttemptTimestamp
    ? (entry.lastAttemptAt ?? entry.enqueuedAt)
    : entry.enqueuedAt;
  const nextEligibleAt = baseAttemptAt + backoff;
  if (now >= nextEligibleAt) {
    return { eligible: true };
  }
  return { eligible: false, remainingBackoffMs: nextEligibleAt - now };
}

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}

async function drainQueuedEntry(opts: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  deliver: DeliverFn;
  stateDir?: string;
  onRecovered?: (entry: QueuedDelivery) => void;
  onFailed?: (entry: QueuedDelivery, errMsg: string) => void;
}): Promise<"recovered" | "failed" | "moved-to-failed" | "already-gone"> {
  const { entry } = opts;
  try {
    await opts.deliver(buildRecoveryDeliverParams(entry, opts.cfg));
    await ackDelivery(entry.id, opts.stateDir);
    opts.onRecovered?.(entry);
    return "recovered";
  } catch (error) {
    const errMsg = formatErrorMessage(error);
    opts.onFailed?.(entry, errMsg);
    if (isPermanentDeliveryError(errMsg)) {
      try {
        await moveToFailed(entry.id, opts.stateDir);
        return "moved-to-failed";
      } catch (error) {
        if (getErrnoCode(error) === "ENOENT") {
          return "already-gone";
        }
      }
    } else {
      try {
        await failDelivery(entry.id, errMsg, opts.stateDir);
        return "failed";
      } catch (error) {
        if (getErrnoCode(error) === "ENOENT") {
          return "already-gone";
        }
      }
    }
    return "failed";
  }
}

export async function drainPendingDeliveries(opts: {
  drainKey: string;
  logLabel: string;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  deliver?: DeliverFn;
  selectEntry: (entry: QueuedDelivery, now: number) => PendingDeliveryDrainDecision;
}): Promise<void> {
  if (drainInProgress.get(opts.drainKey)) {
    opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
    return;
  }

  drainInProgress.set(opts.drainKey, true);
  try {
    const now = Date.now();
    const deliver = opts.deliver ?? (await loadDeliverRuntime()).deliverOutboundPayloads;
    const matchingEntries = (await loadPendingDeliveries(opts.stateDir))
      .map((entry) => ({
        decision: opts.selectEntry(entry, now),
        entry,
      }))
      .filter(
        (item): item is { entry: QueuedDelivery; decision: PendingDeliveryDrainDecision } =>
          item.decision.match,
      )
      .toSorted((a, b) => a.entry.enqueuedAt - b.entry.enqueuedAt);

    if (matchingEntries.length === 0) {
      return;
    }

    opts.log.info(
      `${opts.logLabel}: ${matchingEntries.length} pending message(s) matched ${opts.drainKey}`,
    );

    for (const { entry, decision } of matchingEntries) {
      if (!claimRecoveryEntry(entry.id)) {
        opts.log.info(`${opts.logLabel}: entry ${entry.id} is already being recovered`);
        continue;
      }

      try {
        // Re-read after claim so the queue file remains the source of truth.
        // This prevents stale startup/reconnect snapshots from re-sending an
        // Entry that another recovery path already acked.
        const currentEntry = await loadPendingDelivery(entry.id, opts.stateDir);
        if (!currentEntry) {
          opts.log.info(`${opts.logLabel}: entry ${entry.id} already gone, skipping`);
          continue;
        }

        if (currentEntry.retryCount >= MAX_RETRIES) {
          try {
            await moveToFailed(currentEntry.id, opts.stateDir);
          } catch (error) {
            if (getErrnoCode(error) === "ENOENT") {
              opts.log.info(`${opts.logLabel}: entry ${currentEntry.id} already gone, skipping`);
              continue;
            }
            throw error;
          }
          opts.log.warn(
            `${opts.logLabel}: entry ${currentEntry.id} exceeded max retries and was moved to failed/`,
          );
          continue;
        }

        if (!decision.bypassBackoff) {
          const retryEligibility = isEntryEligibleForRecoveryRetry(currentEntry, Date.now());
          if (!retryEligibility.eligible) {
            opts.log.info(
              `${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
            );
            continue;
          }
        }

        const result = await drainQueuedEntry({
          cfg: opts.cfg,
          deliver,
          entry: currentEntry,
          onFailed: (failedEntry, errMsg) => {
            if (isPermanentDeliveryError(errMsg)) {
              opts.log.warn(
                `${opts.logLabel}: entry ${failedEntry.id} hit permanent error — moving to failed/: ${errMsg}`,
              );
              return;
            }
            opts.log.warn(`${opts.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
          },
          stateDir: opts.stateDir,
        });
        if (result === "recovered") {
          opts.log.info(
            `${opts.logLabel}: drained delivery ${currentEntry.id} on ${currentEntry.channel}`,
          );
        }
      } finally {
        releaseRecoveryEntry(entry.id);
      }
    }
  } finally {
    drainInProgress.delete(opts.drainKey);
  }
}

/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exceed MAX_RETRIES to failed/.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next startup. Default: 60 000. */
  maxRecoveryMs?: number;
}): Promise<RecoverySummary> {
  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return createEmptyRecoverySummary();
  }

  pending.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);
  const summary = createEmptyRecoverySummary();

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    const now = Date.now();
    if (now >= deadline) {
      opts.log.warn(`Recovery time budget exceeded — remaining entries deferred to next startup`);
      await deferRemainingEntriesForBudget(pending.slice(i), opts.stateDir);
      break;
    }

    if (!claimRecoveryEntry(entry.id)) {
      opts.log.info(`Recovery skipped for delivery ${entry.id}: already being processed`);
      continue;
    }

    try {
      const currentEntry = await loadPendingDelivery(entry.id, opts.stateDir);
      if (!currentEntry) {
        opts.log.info(`Recovery skipped for delivery ${entry.id}: already gone`);
        continue;
      }

      if (currentEntry.retryCount >= MAX_RETRIES) {
        opts.log.warn(
          `Delivery ${currentEntry.id} exceeded max retries (${currentEntry.retryCount}/${MAX_RETRIES}) — moving to failed/`,
        );
        await moveEntryToFailedWithLogging(currentEntry.id, opts.log, opts.stateDir);
        summary.skippedMaxRetries += 1;
        continue;
      }

      const currentRetryEligibility = isEntryEligibleForRecoveryRetry(currentEntry, Date.now());
      if (!currentRetryEligibility.eligible) {
        summary.deferredBackoff += 1;
        opts.log.info(
          `Delivery ${currentEntry.id} not ready for retry yet — backoff ${currentRetryEligibility.remainingBackoffMs}ms remaining`,
        );
        continue;
      }

      const result = await drainQueuedEntry({
        cfg: opts.cfg,
        deliver: opts.deliver,
        entry: currentEntry,
        onFailed: (failedEntry, errMsg) => {
          summary.failed += 1;
          if (isPermanentDeliveryError(errMsg)) {
            opts.log.warn(
              `Delivery ${failedEntry.id} hit permanent error — moving to failed/: ${errMsg}`,
            );
            return;
          }
          opts.log.warn(`Retry failed for delivery ${failedEntry.id}: ${errMsg}`);
        },
        onRecovered: (recoveredEntry) => {
          summary.recovered += 1;
          opts.log.info(`Recovered delivery ${recoveredEntry.id} on ${recoveredEntry.channel}`);
        },
        stateDir: opts.stateDir,
      });
      if (result === "moved-to-failed") {
        continue;
      }
    } finally {
      releaseRecoveryEntry(entry.id);
    }
  }

  opts.log.info(
    `Delivery recovery complete: ${summary.recovered} recovered, ${summary.failed} failed, ${summary.skippedMaxRetries} skipped (max retries), ${summary.deferredBackoff} deferred (backoff)`,
  );
  return summary;
}

export { MAX_RETRIES };
