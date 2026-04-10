import type { loadConfig } from "../config/config.js";
import type { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createRunningTaskRun } from "../tasks/task-executor.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { waitForAgentRun } from "./run-wait.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { emitSubagentEndedHookOnce, runOutcomesEqual } from "./subagent-registry-completion.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  persistSubagentSessionTiming,
  resolveArchiveAfterMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-registry");

function shouldDeleteAttachments(entry: SubagentRunRecord) {
  return entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
}

export function createSubagentRunManager(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  endedHookInFlightRunIds: Set<string>;
  persist(): void;
  callGateway: typeof callGateway;
  loadConfig: typeof loadConfig;
  ensureRuntimePluginsLoaded:
    | typeof ensureRuntimePluginsLoadedFn
    | ((args: {
        config: ReturnType<typeof loadConfig>;
        workspaceDir?: string;
        allowGatewaySubagentBinding?: boolean;
      }) => void | Promise<void>);
  ensureListener(): void;
  startSweeper(): void;
  stopSweeper(): void;
  resumeSubagentRun(runId: string): void;
  clearPendingLifecycleError(runId: string): void;
  resolveSubagentWaitTimeoutMs(
    cfg: ReturnType<typeof loadConfig>,
    runTimeoutSeconds?: number,
  ): number;
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted" | "released";
    workspaceDir?: string;
  }): Promise<void>;
  completeCleanupBookkeeping(args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
  }): void;
  completeSubagentRun(args: {
    runId: string;
    endedAt?: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    triggerCleanup: boolean;
  }): Promise<void>;
}) {
  const waitForSubagentCompletion = async (runId: string, waitTimeoutMs: number) => {
    try {
      const wait = await waitForAgentRun({
        callGateway: params.callGateway,
        runId,
        timeoutMs: Math.max(1, Math.floor(waitTimeoutMs)),
      });
      const entry = params.runs.get(runId);
      if (!entry) {
        return;
      }
      let mutated = false;
      if (typeof wait.startedAt === "number") {
        entry.startedAt = wait.startedAt;
        if (typeof entry.sessionStartedAt !== "number") {
          entry.sessionStartedAt = wait.startedAt;
        }
        mutated = true;
      }
      if (typeof wait.endedAt === "number") {
        entry.endedAt = wait.endedAt;
        mutated = true;
      }
      if (!entry.endedAt) {
        entry.endedAt = Date.now();
        mutated = true;
      }
      const waitError = typeof wait.error === "string" ? wait.error : undefined;
      const outcome: SubagentRunOutcome =
        wait.status === "error"
          ? { error: waitError, status: "error" }
          : wait.status === "timeout"
            ? { status: "timeout" }
            : { status: "ok" };
      if (!runOutcomesEqual(entry.outcome, outcome)) {
        entry.outcome = outcome;
        mutated = true;
      }
      if (mutated) {
        params.persist();
      }
      await params.completeSubagentRun({
        accountId: entry.requesterOrigin?.accountId,
        endedAt: entry.endedAt,
        outcome,
        reason:
          wait.status === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
        runId,
        sendFarewell: true,
        triggerCleanup: true,
      });
    } catch {
      // Ignore
    }
  };

  const markSubagentRunForSteerRestart = (runId: string) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.suppressAnnounceReason === "steer-restart") {
      return true;
    }
    entry.suppressAnnounceReason = "steer-restart";
    params.persist();
    return true;
  };

  const clearSubagentRunSteerRestart = (runId: string) => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = params.runs.get(key);
    if (!entry) {
      return false;
    }
    if (entry.suppressAnnounceReason !== "steer-restart") {
      return true;
    }
    entry.suppressAnnounceReason = undefined;
    params.persist();
    // If the interrupted run already finished while suppression was active, retry
    // Cleanup now so completion output is not lost when restart dispatch fails.
    params.resumedRuns.delete(key);
    if (typeof entry.endedAt === "number" && !entry.cleanupCompletedAt) {
      params.resumeSubagentRun(key);
    }
    return true;
  };

  const replaceSubagentRunAfterSteer = (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    preserveFrozenResultFallback?: boolean;
  }) => {
    const previousRunId = replaceParams.previousRunId.trim();
    const nextRunId = replaceParams.nextRunId.trim();
    if (!previousRunId || !nextRunId) {
      return false;
    }

    const previous = params.runs.get(previousRunId);
    const source = previous ?? replaceParams.fallback;
    if (!source) {
      return false;
    }

    if (previousRunId !== nextRunId) {
      params.clearPendingLifecycleError(previousRunId);
      if (shouldDeleteAttachments(source)) {
        void safeRemoveAttachmentsDir(source);
      }
      params.runs.delete(previousRunId);
      params.resumedRuns.delete(previousRunId);
    }

    const now = Date.now();
    const cfg = params.loadConfig();
    const archiveAfterMs = resolveArchiveAfterMs(cfg);
    const spawnMode = source.spawnMode === "session" ? "session" : "run";
    const archiveAtMs =
      spawnMode === "session" || source.cleanup === "keep"
        ? undefined
        : archiveAfterMs
          ? now + archiveAfterMs
          : undefined;
    const runTimeoutSeconds = replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
    const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
    const accumulatedRuntimeMs =
      getSubagentSessionRuntimeMs(
        source,
        typeof source.endedAt === "number" ? source.endedAt : now,
      ) ?? 0;

    const next: SubagentRunRecord = {
      ...source,
      accumulatedRuntimeMs,
      announceRetryCount: undefined,
      archiveAtMs,
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      createdAt: now,
      endedAt: undefined,
      endedHookEmittedAt: undefined,
      endedReason: undefined,
      fallbackFrozenResultCapturedAt: preserveFrozenResultFallback
        ? source.frozenResultCapturedAt
        : undefined,
      fallbackFrozenResultText: preserveFrozenResultFallback ? source.frozenResultText : undefined,
      frozenResultCapturedAt: undefined,
      frozenResultText: undefined,
      lastAnnounceRetryAt: undefined,
      outcome: undefined,
      runId: nextRunId,
      runTimeoutSeconds,
      sessionStartedAt,
      spawnMode,
      startedAt: now,
      suppressAnnounceReason: undefined,
      wakeOnDescendantSettle: undefined,
    };

    params.runs.set(nextRunId, next);
    params.ensureListener();
    params.persist();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    void waitForSubagentCompletion(nextRunId, waitTimeoutMs);
    return true;
  };

  const registerSubagentRun = (registerParams: {
    runId: string;
    childSessionKey: string;
    controllerSessionKey?: string;
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    requesterDisplayKey: string;
    task: string;
    cleanup: "delete" | "keep";
    label?: string;
    model?: string;
    workspaceDir?: string;
    runTimeoutSeconds?: number;
    expectsCompletionMessage?: boolean;
    spawnMode?: "run" | "session";
    attachmentsDir?: string;
    attachmentsRootDir?: string;
    retainAttachmentsOnKeep?: boolean;
  }) => {
    const now = Date.now();
    const cfg = params.loadConfig();
    const archiveAfterMs = resolveArchiveAfterMs(cfg);
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const archiveAtMs =
      spawnMode === "session" || registerParams.cleanup === "keep"
        ? undefined
        : archiveAfterMs
          ? now + archiveAfterMs
          : undefined;
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = params.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    params.runs.set(registerParams.runId, {
      accumulatedRuntimeMs: 0,
      archiveAtMs,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      childSessionKey: registerParams.childSessionKey,
      cleanup: registerParams.cleanup,
      cleanupHandled: false,
      controllerSessionKey:
        registerParams.controllerSessionKey ?? registerParams.requesterSessionKey,
      createdAt: now,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,
      label: registerParams.label,
      model: registerParams.model,
      requesterDisplayKey: registerParams.requesterDisplayKey,
      requesterOrigin,
      requesterSessionKey: registerParams.requesterSessionKey,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
      runId: registerParams.runId,
      runTimeoutSeconds,
      sessionStartedAt: now,
      spawnMode,
      startedAt: now,
      task: registerParams.task,
      wakeOnDescendantSettle: undefined,
      workspaceDir: registerParams.workspaceDir,
    });
    try {
      createRunningTaskRun({
        childSessionKey: registerParams.childSessionKey,
        deliveryStatus:
          registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
        label: registerParams.label,
        lastEventAt: now,
        ownerKey: registerParams.requesterSessionKey,
        requesterOrigin,
        runId: registerParams.runId,
        runtime: "subagent",
        scopeKind: "session",
        sourceId: registerParams.runId,
        startedAt: now,
        task: registerParams.task,
      });
    } catch (error) {
      log.warn("Failed to create background task for subagent run", {
        error,
        runId: registerParams.runId,
      });
    }
    params.ensureListener();
    params.persist();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    params.startSweeper();
    // Wait for subagent completion via gateway RPC (cross-process).
    // The in-process lifecycle listener is a fallback for embedded runs.
    void waitForSubagentCompletion(registerParams.runId, waitTimeoutMs);
  };

  const releaseSubagentRun = (runId: string) => {
    params.clearPendingLifecycleError(runId);
    const entry = params.runs.get(runId);
    if (entry) {
      if (shouldDeleteAttachments(entry)) {
        void safeRemoveAttachmentsDir(entry);
      }
      void params.notifyContextEngineSubagentEnded({
        childSessionKey: entry.childSessionKey,
        reason: "released",
        workspaceDir: entry.workspaceDir,
      });
    }
    const didDelete = params.runs.delete(runId);
    if (didDelete) {
      params.persist();
    }
    if (params.runs.size === 0) {
      params.stopSweeper();
    }
  };

  const markSubagentRunTerminated = (markParams: {
    runId?: string;
    childSessionKey?: string;
    reason?: string;
  }): number => {
    const runIds = new Set<string>();
    if (typeof markParams.runId === "string" && markParams.runId.trim()) {
      runIds.add(markParams.runId.trim());
    }
    if (typeof markParams.childSessionKey === "string" && markParams.childSessionKey.trim()) {
      for (const [runId, entry] of params.runs.entries()) {
        if (entry.childSessionKey === markParams.childSessionKey.trim()) {
          runIds.add(runId);
        }
      }
    }
    if (runIds.size === 0) {
      return 0;
    }

    const now = Date.now();
    const reason = markParams.reason?.trim() || "killed";
    let updated = 0;
    const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
    for (const runId of runIds) {
      params.clearPendingLifecycleError(runId);
      const entry = params.runs.get(runId);
      if (!entry) {
        continue;
      }
      if (typeof entry.endedAt === "number") {
        continue;
      }
      entry.endedAt = now;
      entry.outcome = { error: reason, status: "error" };
      entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
      entry.cleanupHandled = true;
      entry.cleanupCompletedAt = now;
      entry.suppressAnnounceReason = "killed";
      if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
        entriesByChildSessionKey.set(entry.childSessionKey, entry);
      }
      updated += 1;
    }
    if (updated > 0) {
      params.persist();
      for (const entry of entriesByChildSessionKey.values()) {
        void persistSubagentSessionTiming(entry).catch((error) => {
          log.warn("failed to persist killed subagent session timing", {
            childSessionKey: entry.childSessionKey,
            error,
            runId: entry.runId,
          });
        });
        if (shouldDeleteAttachments(entry)) {
          void safeRemoveAttachmentsDir(entry);
        }
        params.completeCleanupBookkeeping({
          cleanup: entry.cleanup,
          completedAt: now,
          entry,
          runId: entry.runId,
        });
        const cfg = params.loadConfig();
        void Promise.resolve(
          params.ensureRuntimePluginsLoaded({
            allowGatewaySubagentBinding: true,
            config: cfg,
            workspaceDir: entry.workspaceDir,
          }),
        )
          .then(() =>
            emitSubagentEndedHookOnce({
              accountId: entry.requesterOrigin?.accountId,
              entry,
              error: reason,
              inFlightRunIds: params.endedHookInFlightRunIds,
              outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
              persist: () => params.persist(),
              reason: SUBAGENT_ENDED_REASON_KILLED,
              sendFarewell: true,
            }),
          )
          .catch(() => {
            // Hook failures should not break termination flow.
          });
      }
    }
    return updated;
  };

  return {
    clearSubagentRunSteerRestart,
    markSubagentRunForSteerRestart,
    markSubagentRunTerminated,
    registerSubagentRun,
    releaseSubagentRun,
    replaceSubagentRunAfterSteer,
    waitForSubagentCompletion,
  };
}
