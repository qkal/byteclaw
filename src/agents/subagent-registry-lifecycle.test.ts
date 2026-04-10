import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const helperMocks = vi.hoisted(() => ({
  logAnnounceGiveUp: vi.fn(),
  persistSubagentSessionTiming: vi.fn(async () => {}),
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const lifecycleEventMocks = vi.hoisted(() => ({
  emitSessionLifecycleEvent: vi.fn(),
}));

const browserLifecycleCleanupMocks = vi.hoisted(() => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../tasks/task-executor.js", () => ({
  completeTaskRunByRunId: taskExecutorMocks.completeTaskRunByRunId,
  failTaskRunByRunId: taskExecutorMocks.failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId: taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId,
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: lifecycleEventMocks.emitSessionLifecycleEvent,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd:
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: runtimeMocks.log,
  },
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (origin: unknown) => origin ?? "agent",
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: vi.fn(async () => false),
}));

vi.mock("./subagent-registry-cleanup.js", () => ({
  resolveCleanupCompletionReason: () => SUBAGENT_ENDED_REASON_COMPLETE,
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "retry-limit" }),
}));

vi.mock("./subagent-registry-completion.js", () => ({
  runOutcomesEqual: (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right),
}));

vi.mock("./subagent-registry-helpers.js", () => ({
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: 30 * 60_000,
  ANNOUNCE_EXPIRY_MS: 5 * 60_000,
  MAX_ANNOUNCE_RETRY_COUNT: 3,
  MIN_ANNOUNCE_RETRY_DELAY_MS: 1000,
  capFrozenResultText: (text: string) => text.trim(),
  logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
  persistSubagentSessionTiming: helperMocks.persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs: (retryCount: number) =>
    Math.min(1000 * 2 ** Math.max(0, retryCount - 1), 8000),
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
}));

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    childSessionKey: "agent:main:subagent:child",
    cleanup: "keep",
    createdAt: 1000,
    requesterDisplayKey: "main",
    requesterSessionKey: "agent:main:main",
    runId: "run-1",
    startedAt: 2000,
    task: "finish the task",
    ...overrides,
  };
}

describe("subagent registry lifecycle hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockClear();
  });

  it("does not reject completion when task finalization throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    taskExecutorMocks.completeTaskRunByRunId.mockImplementation(() => {
      throw new Error("task store boom");
    });

    const controller = createSubagentRegistryLifecycleController({
      captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      persist,
      resumeSubagentRun: vi.fn(),
      resumedRuns: new Set(),
      runSubagentAnnounceFlow: vi.fn(async () => true),
      runs,
      shouldEmitEndedHookForRun: () => false,
      subagentAnnounceTimeoutMs: 1000,
      suppressAnnounceForSteerRestart: () => false,
      warn,
    });

    await expect(
      controller.completeSubagentRun({
        endedAt: 4000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        runId: entry.runId,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "failed to finalize subagent background task state",
      expect.objectContaining({
        childSessionKey: "agent:main:…",
        error: { message: "task store boom", name: "Error" },
        outcomeStatus: "ok",
        runId: "***",
      }),
    );
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(1);
    expect(lifecycleEventMocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      label: undefined,
      parentSessionKey: "agent:main:main",
      reason: "subagent-status",
      sessionKey: "agent:main:subagent:child",
    });
  });

  it("does not reject cleanup give-up when task delivery status update throws", async () => {
    const persist = vi.fn();
    const warn = vi.fn();
    const entry = createRunEntry({
      endedAt: 4000,
      expectsCompletionMessage: false,
      retainAttachmentsOnKeep: true,
    });
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockImplementation(() => {
      throw new Error("delivery state boom");
    });

    const controller = createSubagentRegistryLifecycleController({
      captureSubagentCompletionReply: vi.fn(async () => undefined),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      persist,
      resumeSubagentRun: vi.fn(),
      resumedRuns: new Set(),
      runSubagentAnnounceFlow: vi.fn(async () => true),
      runs: new Map([[entry.runId, entry]]),
      shouldEmitEndedHookForRun: () => false,
      subagentAnnounceTimeoutMs: 1000,
      suppressAnnounceForSteerRestart: () => false,
      warn,
    });

    await expect(
      controller.finalizeResumedAnnounceGiveUp({
        entry,
        reason: "retry-limit",
        runId: entry.runId,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "failed to update subagent background task delivery state",
      expect.objectContaining({
        childSessionKey: "agent:main:…",
        deliveryStatus: "failed",
        error: { message: "delivery state boom", name: "Error" },
        runId: "***",
      }),
    );
    expect(entry.cleanupCompletedAt).toBeTypeOf("number");
    expect(persist).toHaveBeenCalled();
  });

  it("cleans up tracked browser sessions before subagent cleanup flow", async () => {
    const persist = vi.fn();
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createSubagentRegistryLifecycleController({
      captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      persist,
      resumeSubagentRun: vi.fn(),
      resumedRuns: new Set(),
      runSubagentAnnounceFlow,
      runs: new Map([[entry.runId, entry]]),
      shouldEmitEndedHookForRun: () => false,
      subagentAnnounceTimeoutMs: 1000,
      suppressAnnounceForSteerRestart: () => false,
      warn: vi.fn(),
    });

    await expect(
      controller.completeSubagentRun({
        endedAt: 4000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        runId: entry.runId,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledWith(
      {
        onWarn: expect.any(Function),
        sessionKeys: [entry.childSessionKey],
      },
    );
    expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey: entry.childSessionKey,
      }),
    );
  });

  it("does not wait for a completion reply when the run does not expect one", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const captureSubagentCompletionReply = vi.fn(async () => undefined);

    const controller = createSubagentRegistryLifecycleController({
      captureSubagentCompletionReply,
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      persist: vi.fn(),
      resumeSubagentRun: vi.fn(),
      resumedRuns: new Set(),
      runSubagentAnnounceFlow: vi.fn(async () => false),
      runs: new Map([[entry.runId, entry]]),
      shouldEmitEndedHookForRun: () => false,
      subagentAnnounceTimeoutMs: 1000,
      suppressAnnounceForSteerRestart: () => false,
      warn: vi.fn(),
    });

    await expect(
      controller.completeSubagentRun({
        endedAt: 4000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        runId: entry.runId,
        triggerCleanup: false,
      }),
    ).resolves.toBeUndefined();

    expect(captureSubagentCompletionReply).toHaveBeenCalledWith(entry.childSessionKey, {
      waitForReply: false,
    });
  });

  it("skips browser cleanup when steer restart suppresses cleanup flow", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: false,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => true);

    const controller = createSubagentRegistryLifecycleController({
      captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: () => 0,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      persist: vi.fn(),
      resumeSubagentRun: vi.fn(),
      resumedRuns: new Set(),
      runSubagentAnnounceFlow,
      runs: new Map([[entry.runId, entry]]),
      shouldEmitEndedHookForRun: () => false,
      subagentAnnounceTimeoutMs: 1000,
      suppressAnnounceForSteerRestart: () => true,
      warn: vi.fn(),
    });

    await expect(
      controller.completeSubagentRun({
        endedAt: 4000,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        runId: entry.runId,
        triggerCleanup: true,
      }),
    ).resolves.toBeUndefined();

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });
});
