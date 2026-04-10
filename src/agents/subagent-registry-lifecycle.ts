import { SILENT_REPLY_TOKEN, isSilentReplyText } from "../auto-reply/tokens.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { formatErrorMessage, readErrorName } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/task-executor.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { runSubagentAnnounceFlow } from "./subagent-announce.js";
import { type SubagentRunOutcome, captureSubagentCompletionReply } from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import { runOutcomesEqual } from "./subagent-registry-completion.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  MAX_ANNOUNCE_RETRY_COUNT,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  capFrozenResultText,
  logAnnounceGiveUp,
  persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentRegistryLifecycleController(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  persist(): void;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
  shouldEmitEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }): boolean;
  emitSubagentEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
  }): Promise<void>;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted";
    workspaceDir?: string;
  }): Promise<void>;
  resumeSubagentRun(runId: string): void;
  captureSubagentCompletionReply: typeof captureSubagentCompletionReply;
  runSubagentAnnounceFlow: typeof runSubagentAnnounceFlow;
  warn(message: string, meta?: Record<string, unknown>): void;
}) {
  const maskRunId = (runId: string): string => {
    const trimmed = runId.trim();
    if (!trimmed) {
      return "unknown";
    }
    if (trimmed.length <= 8) {
      return "***";
    }
    return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
  };

  const maskSessionKey = (sessionKey: string): string => {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return "unknown";
    }
    const prefix = trimmed.split(":").slice(0, 2).join(":") || "session";
    return `${prefix}:…`;
  };

  const buildSafeLifecycleErrorMeta = (err: unknown): Record<string, string> => {
    const message = formatErrorMessage(err);
    const name = readErrorName(err);
    return name ? { message, name } : { message };
  };

  const safeSetSubagentTaskDeliveryStatus = (args: {
    runId: string;
    childSessionKey: string;
    deliveryStatus: "failed";
  }) => {
    try {
      setDetachedTaskDeliveryStatusByRunId({
        deliveryStatus: args.deliveryStatus,
        runId: args.runId,
        runtime: "subagent",
        sessionKey: args.childSessionKey,
      });
    } catch (error) {
      params.warn("failed to update subagent background task delivery state", {
        childSessionKey: maskSessionKey(args.childSessionKey),
        deliveryStatus: args.deliveryStatus,
        error: buildSafeLifecycleErrorMeta(error),
        runId: maskRunId(args.runId),
      });
    }
  };

  const safeFinalizeSubagentTaskRun = (args: {
    entry: SubagentRunRecord;
    outcome: SubagentRunOutcome;
  }) => {
    const endedAt = args.entry.endedAt ?? Date.now();
    const lastEventAt = endedAt;
    try {
      if (args.outcome.status === "ok") {
        completeTaskRunByRunId({
          endedAt,
          lastEventAt,
          progressSummary: args.entry.frozenResultText ?? undefined,
          runId: args.entry.runId,
          runtime: "subagent",
          sessionKey: args.entry.childSessionKey,
          terminalSummary: null,
        });
        return;
      }
      failTaskRunByRunId({
        endedAt,
        error: args.outcome.status === "error" ? args.outcome.error : undefined,
        lastEventAt,
        progressSummary: args.entry.frozenResultText ?? undefined,
        runId: args.entry.runId,
        runtime: "subagent",
        sessionKey: args.entry.childSessionKey,
        status: args.outcome.status === "timeout" ? "timed_out" : "failed",
        terminalSummary: null,
      });
    } catch (error) {
      params.warn("failed to finalize subagent background task state", {
        childSessionKey: maskSessionKey(args.entry.childSessionKey),
        error: buildSafeLifecycleErrorMeta(error),
        outcomeStatus: args.outcome.status,
        runId: maskRunId(args.entry.runId),
      });
    }
  };

  const freezeRunResultAtCompletion = async (entry: SubagentRunRecord): Promise<boolean> => {
    if (entry.frozenResultText !== undefined) {
      return false;
    }
    try {
      const captured = await params.captureSubagentCompletionReply(entry.childSessionKey, {
        waitForReply: entry.expectsCompletionMessage === true,
      });
      entry.frozenResultText = captured?.trim() ? capFrozenResultText(captured) : null;
    } catch {
      entry.frozenResultText = null;
    }
    entry.frozenResultCapturedAt = Date.now();
    return true;
  };

  const listPendingCompletionRunsForSession = (sessionKey: string): SubagentRunRecord[] => {
    const key = sessionKey.trim();
    if (!key) {
      return [];
    }
    const out: SubagentRunRecord[] = [];
    for (const entry of params.runs.values()) {
      if (entry.childSessionKey !== key) {
        continue;
      }
      if (entry.expectsCompletionMessage !== true) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (typeof entry.cleanupCompletedAt === "number") {
        continue;
      }
      out.push(entry);
    }
    return out;
  };

  const refreshFrozenResultFromSession = async (sessionKey: string): Promise<boolean> => {
    const candidates = listPendingCompletionRunsForSession(sessionKey);
    if (candidates.length === 0) {
      return false;
    }

    let captured: string | undefined;
    try {
      captured = await captureSubagentCompletionReply(sessionKey);
    } catch {
      return false;
    }
    const trimmed = captured?.trim();
    if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
      return false;
    }

    const nextFrozen = capFrozenResultText(trimmed);
    const capturedAt = Date.now();
    let changed = false;
    for (const entry of candidates) {
      if (entry.frozenResultText === nextFrozen) {
        continue;
      }
      entry.frozenResultText = nextFrozen;
      entry.frozenResultCapturedAt = capturedAt;
      changed = true;
    }
    if (changed) {
      params.persist();
    }
    return changed;
  };

  const emitCompletionEndedHookIfNeeded = async (
    entry: SubagentRunRecord,
    reason: SubagentLifecycleEndedReason,
  ) => {
    if (
      entry.expectsCompletionMessage === true &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason,
      })
    ) {
      await params.emitSubagentEndedHookForRun({
        entry,
        reason,
        sendFarewell: true,
      });
    }
  };

  const finalizeResumedAnnounceGiveUp = async (giveUpParams: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
  }) => {
    safeSetSubagentTaskDeliveryStatus({
      childSessionKey: giveUpParams.entry.childSessionKey,
      deliveryStatus: "failed",
      runId: giveUpParams.runId,
    });
    giveUpParams.entry.wakeOnDescendantSettle = undefined;
    giveUpParams.entry.fallbackFrozenResultText = undefined;
    giveUpParams.entry.fallbackFrozenResultCapturedAt = undefined;
    const shouldDeleteAttachments =
      giveUpParams.entry.cleanup === "delete" || !giveUpParams.entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(giveUpParams.entry);
    }
    const completionReason = resolveCleanupCompletionReason(giveUpParams.entry);
    await emitCompletionEndedHookIfNeeded(giveUpParams.entry, completionReason);
    logAnnounceGiveUp(giveUpParams.entry, giveUpParams.reason);
    completeCleanupBookkeeping({
      cleanup: giveUpParams.entry.cleanup,
      completedAt: Date.now(),
      entry: giveUpParams.entry,
      runId: giveUpParams.runId,
    });
  };

  const beginSubagentCleanup = (runId: string) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return false;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      return false;
    }
    entry.cleanupHandled = true;
    params.persist();
    return true;
  };

  const retryDeferredCompletedAnnounces = (excludeRunId?: string) => {
    const now = Date.now();
    for (const [runId, entry] of params.runs.entries()) {
      if (excludeRunId && runId === excludeRunId) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        continue;
      }
      if (entry.cleanupCompletedAt || entry.cleanupHandled) {
        continue;
      }
      if (params.suppressAnnounceForSteerRestart(entry)) {
        continue;
      }
      const endedAgo = now - (entry.endedAt ?? now);
      if (entry.expectsCompletionMessage !== true && endedAgo > ANNOUNCE_EXPIRY_MS) {
        if (!beginSubagentCleanup(runId)) {
          continue;
        }
        void finalizeResumedAnnounceGiveUp({
          entry,
          reason: "expiry",
          runId,
        }).catch((error) => {
          defaultRuntime.log(
            `[warn] Subagent expiry finalize failed during deferred retry for run ${runId}: ${String(error)}`,
          );
          const current = params.runs.get(runId);
          if (!current || current.cleanupCompletedAt) {
            return;
          }
          current.cleanupHandled = false;
          params.persist();
        });
        continue;
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }
  };

  const completeCleanupBookkeeping = (cleanupParams: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
  }) => {
    if (cleanupParams.cleanup === "delete") {
      params.clearPendingLifecycleError(cleanupParams.runId);
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: cleanupParams.entry.childSessionKey,
        reason: "deleted",
        workspaceDir: cleanupParams.entry.workspaceDir,
      });
      params.runs.delete(cleanupParams.runId);
      params.persist();
      retryDeferredCompletedAnnounces(cleanupParams.runId);
      return;
    }
    void params.notifyContextEngineSubagentEnded({
      childSessionKey: cleanupParams.entry.childSessionKey,
      reason: "completed",
      workspaceDir: cleanupParams.entry.workspaceDir,
    });
    cleanupParams.entry.cleanupCompletedAt = cleanupParams.completedAt;
    params.persist();
    retryDeferredCompletedAnnounces(cleanupParams.runId);
  };

  const finalizeSubagentCleanup = async (
    runId: string,
    cleanup: "delete" | "keep",
    didAnnounce: boolean,
  ) => {
    const entry = params.runs.get(runId);
    if (!entry) {
      return;
    }
    if (didAnnounce) {
      setDetachedTaskDeliveryStatusByRunId({
        deliveryStatus: "delivered",
        runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
      });
      entry.wakeOnDescendantSettle = undefined;
      entry.fallbackFrozenResultText = undefined;
      entry.fallbackFrozenResultCapturedAt = undefined;
      const completionReason = resolveCleanupCompletionReason(entry);
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      if (cleanup === "delete") {
        entry.frozenResultText = undefined;
        entry.frozenResultCapturedAt = undefined;
      }
      completeCleanupBookkeeping({
        cleanup,
        completedAt: Date.now(),
        entry,
        runId,
      });
      return;
    }

    const now = Date.now();
    const deferredDecision = resolveDeferredCleanupDecision({
      activeDescendantRuns: Math.max(0, params.countPendingDescendantRuns(entry.childSessionKey)),
      announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
      announceExpiryMs: ANNOUNCE_EXPIRY_MS,
      deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
      entry,
      maxAnnounceRetryCount: MAX_ANNOUNCE_RETRY_COUNT,
      now,
      resolveAnnounceRetryDelayMs,
    });

    if (deferredDecision.kind === "defer-descendants") {
      entry.lastAnnounceRetryAt = now;
      entry.wakeOnDescendantSettle = true;
      entry.cleanupHandled = false;
      params.resumedRuns.delete(runId);
      params.persist();
      setTimeout(() => {
        params.resumeSubagentRun(runId);
      }, deferredDecision.delayMs).unref?.();
      return;
    }

    if (deferredDecision.retryCount != null) {
      entry.announceRetryCount = deferredDecision.retryCount;
      entry.lastAnnounceRetryAt = now;
    }

    if (deferredDecision.kind === "give-up") {
      setDetachedTaskDeliveryStatusByRunId({
        deliveryStatus: "failed",
        runId,
        runtime: "subagent",
        sessionKey: entry.childSessionKey,
      });
      entry.wakeOnDescendantSettle = undefined;
      entry.fallbackFrozenResultText = undefined;
      entry.fallbackFrozenResultCapturedAt = undefined;
      const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
      if (shouldDeleteAttachments) {
        await safeRemoveAttachmentsDir(entry);
      }
      const completionReason = resolveCleanupCompletionReason(entry);
      await emitCompletionEndedHookIfNeeded(entry, completionReason);
      logAnnounceGiveUp(entry, deferredDecision.reason);
      completeCleanupBookkeeping({
        cleanup,
        completedAt: now,
        entry,
        runId,
      });
      return;
    }

    entry.cleanupHandled = false;
    params.resumedRuns.delete(runId);
    params.persist();
    if (deferredDecision.resumeDelayMs == null) {
      return;
    }
    setTimeout(() => {
      params.resumeSubagentRun(runId);
    }, deferredDecision.resumeDelayMs).unref?.();
  };

  const startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean => {
    if (!beginSubagentCleanup(runId)) {
      return false;
    }
    const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
    const finalizeAnnounceCleanup = (didAnnounce: boolean) => {
      void finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce).catch((error) => {
        defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(error)}`);
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        params.persist();
      });
    };

    void params
      .runSubagentAnnounceFlow({
        childRunId: entry.runId,
        childSessionKey: entry.childSessionKey,
        cleanup: entry.cleanup,
        endedAt: entry.endedAt,
        expectsCompletionMessage: entry.expectsCompletionMessage,
        fallbackReply: entry.fallbackFrozenResultText ?? undefined,
        label: entry.label,
        outcome: entry.outcome,
        requesterDisplayKey: entry.requesterDisplayKey,
        requesterOrigin,
        requesterSessionKey: entry.requesterSessionKey,
        roundOneReply: entry.frozenResultText ?? undefined,
        spawnMode: entry.spawnMode,
        startedAt: entry.startedAt,
        task: entry.task,
        timeoutMs: params.subagentAnnounceTimeoutMs,
        waitForCompletion: false,
        wakeOnDescendantSettle: entry.wakeOnDescendantSettle === true,
      })
      .then((didAnnounce) => {
        finalizeAnnounceCleanup(didAnnounce);
      })
      .catch((error) => {
        defaultRuntime.log(
          `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
        );
        finalizeAnnounceCleanup(false);
      });
    return true;
  };

  const completeSubagentRun = async (completeParams: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
  }) => {
    params.clearPendingLifecycleError(completeParams.runId);
    const entry = params.runs.get(completeParams.runId);
    if (!entry) {
      return;
    }

    let mutated = false;
    if (
      completeParams.reason === SUBAGENT_ENDED_REASON_COMPLETE &&
      entry.suppressAnnounceReason === "killed" &&
      (entry.cleanupHandled || typeof entry.cleanupCompletedAt === "number")
    ) {
      entry.suppressAnnounceReason = undefined;
      entry.cleanupHandled = false;
      entry.cleanupCompletedAt = undefined;
      mutated = true;
    }

    const endedAt =
      typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
    if (entry.endedAt !== endedAt) {
      entry.endedAt = endedAt;
      mutated = true;
    }
    if (!runOutcomesEqual(entry.outcome, completeParams.outcome)) {
      entry.outcome = completeParams.outcome;
      mutated = true;
    }
    if (entry.endedReason !== completeParams.reason) {
      entry.endedReason = completeParams.reason;
      mutated = true;
    }

    if (await freezeRunResultAtCompletion(entry)) {
      mutated = true;
    }

    if (mutated) {
      params.persist();
    }
    safeFinalizeSubagentTaskRun({
      entry,
      outcome: completeParams.outcome,
    });

    try {
      await persistSubagentSessionTiming(entry);
    } catch (error) {
      params.warn("failed to persist subagent session timing", {
        childSessionKey: entry.childSessionKey,
        error,
        runId: entry.runId,
      });
    }

    const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
    if (mutated && !suppressedForSteerRestart) {
      emitSessionLifecycleEvent({
        label: entry.label,
        parentSessionKey: entry.requesterSessionKey,
        reason: "subagent-status",
        sessionKey: entry.childSessionKey,
      });
    }
    const shouldEmitEndedHook =
      !suppressedForSteerRestart &&
      params.shouldEmitEndedHookForRun({
        entry,
        reason: completeParams.reason,
      });
    const shouldDeferEndedHook =
      shouldEmitEndedHook &&
      completeParams.triggerCleanup &&
      entry.expectsCompletionMessage === true &&
      !suppressedForSteerRestart;
    if (!shouldDeferEndedHook && shouldEmitEndedHook) {
      await params.emitSubagentEndedHookForRun({
        accountId: completeParams.accountId,
        entry,
        reason: completeParams.reason,
        sendFarewell: completeParams.sendFarewell,
      });
    }

    if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
      return;
    }

    await cleanupBrowserSessionsForLifecycleEnd({
      onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
      sessionKeys: [entry.childSessionKey],
    });

    startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
  };

  return {
    completeCleanupBookkeeping,
    completeSubagentRun,
    finalizeResumedAnnounceGiveUp,
    refreshFrozenResultFromSession,
    startSubagentAnnounceCleanupFlow,
  };
}
