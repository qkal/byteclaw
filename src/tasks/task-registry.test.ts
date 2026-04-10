import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import { startAcpSpawnParentStreamRelay } from "../agents/acp-spawn-parent-stream.js";
import { resetCronActiveJobsForTests } from "../cron/active-jobs.js";
import {
  emitAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import {
  hasPendingHeartbeatWake,
  resetHeartbeatWakeStateForTests,
} from "../infra/heartbeat-wake.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import {
  cancelTaskById,
  createTaskRecord,
  findLatestTaskForOwnerKey,
  findLatestTaskForRelatedSessionKey,
  findTaskByRunId,
  getTaskById,
  getTaskRegistrySummary,
  isParentFlowLinkError,
  linkTaskToFlowById,
  listTaskRecords,
  listTasksForOwnerKey,
  markTaskRunningByRunId,
  markTaskTerminalById,
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
  recordTaskProgressByRunId,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  resolveTaskForLookupToken,
  setTaskProgressById,
  setTaskRegistryDeliveryRuntimeForTests,
  setTaskTimingById,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import {
  getInspectableTaskAuditSummary,
  previewTaskRegistryMaintenance,
  reconcileInspectableTasks,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  startTaskRegistryMaintenance,
  stopTaskRegistryMaintenanceForTests,
  sweepTaskRegistry,
} from "./task-registry.maintenance.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const hoisted = vi.hoisted(() => {
  const sendMessageMock = vi.fn();
  const cancelSessionMock = vi.fn();
  const killSubagentRunAdminMock = vi.fn();
  return {
    cancelSessionMock,
    killSubagentRunAdminMock,
    sendMessageMock,
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: hoisted.cancelSessionMock,
  }),
}));

vi.mock("../agents/subagent-control.js", () => ({
  killSubagentRunAdmin: (params: unknown) => hoisted.killSubagentRunAdminMock(params),
}));

function configureTaskRegistryMaintenanceRuntimeForTest(params: {
  currentTasks: Map<string, ReturnType<typeof createTaskRecord>>;
  snapshotTasks: ReturnType<typeof createTaskRecord>[];
}): void {
  const emptyAcpEntry = {
    cfg: {} as never,
    entry: undefined,
    sessionKey: "",
    storePath: "",
    storeReadFailed: false,
    storeSessionKey: "",
  } satisfies AcpSessionStoreEntry;
  setTaskRegistryMaintenanceRuntimeForTests({
    deleteTaskRecordById: (taskId: string) => params.currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getAgentRunContext: () => undefined,
    getTaskById: (taskId: string) => params.currentTasks.get(taskId),
    isCronJobActive: () => false,
    listTaskRecords: () => params.snapshotTasks,
    loadSessionStore: () => ({}),
    markTaskLostById: (patch: {
      taskId: string;
      endedAt: number;
      lastEventAt?: number;
      error?: string;
      cleanupAfter?: number;
    }) => {
      const current = params.currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        endedAt: patch.endedAt,
        lastEventAt: patch.lastEventAt ?? patch.endedAt,
        status: "lost" as const,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.cleanupAfter !== undefined ? { cleanupAfter: patch.cleanupAfter } : {}),
      };
      params.currentTasks.set(patch.taskId, next);
      return next;
    },
    maybeDeliverTaskTerminalUpdate: async () => null,
    parseAgentSessionKey: () => null as ParsedAgentSessionKey | null,
    readAcpSessionEntry: () => emptyAcpEntry,
    resolveStorePath: () => "",
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: (patch: { taskId: string; cleanupAfter: number }) => {
      const current = params.currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        cleanupAfter: patch.cleanupAfter,
      };
      params.currentTasks.set(patch.taskId, next);
      return next;
    },
  });
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2000, stepMs = 5) {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
}

async function flushAsyncWork(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

async function withTaskRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-task-registry-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    try {
      return await run(root);
    } finally {
      // Close both sqlite-backed registries before Windows temp-dir cleanup tries to remove them.
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
    }
  });
}

function configureInMemoryTaskStoresForLinkValidationTests() {
  configureTaskRegistryRuntime({
    store: {
      close: () => {},
      deleteTask: () => {},
      loadSnapshot: () => ({
        deliveryStates: new Map(),
        tasks: new Map(),
      }),
      saveSnapshot: () => {},
      upsertTask: () => {},
    },
  });
  configureTaskFlowRegistryRuntime({
    store: {
      close: () => {},
      deleteFlow: () => {},
      loadSnapshot: () => ({
        flows: new Map(),
      }),
      saveSnapshot: () => {},
      upsertFlow: () => {},
    },
  });
}

describe("task-registry", () => {
  beforeEach(() => {
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage: hoisted.sendMessageMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetAgentRunContextForTest();
    resetCronActiveJobsForTests();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryMaintenanceRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    hoisted.sendMessageMock.mockReset();
    hoisted.cancelSessionMock.mockReset();
    hoisted.killSubagentRunAdminMock.mockReset();
  });

  it("updates task status from lifecycle events", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "not_applicable",
        ownerKey: "agent:main:main",
        runId: "run-1",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 100,
        status: "running",
        task: "Do the thing",
      });

      emitAgentEvent({
        data: {
          text: "working",
        },
        runId: "run-1",
        stream: "assistant",
      });
      emitAgentEvent({
        data: {
          endedAt: 250,
          phase: "end",
        },
        runId: "run-1",
        stream: "lifecycle",
      });

      expect(findTaskByRunId("run-1")).toMatchObject({
        endedAt: 250,
        runtime: "acp",
        status: "succeeded",
      });
    });
  });

  it("ignores late agent events for operator-cancelled tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        childSessionKey: "agent:main:main",
        deliveryStatus: "not_applicable",
        ownerKey: "agent:main:main",
        runId: "run-cancel-then-end",
        runtime: "cli",
        scopeKind: "session",
        startedAt: 100,
        status: "running",
        task: "Do the thing",
      });

      markTaskTerminalById({
        endedAt: 200,
        error: "Cancelled by operator.",
        lastEventAt: 200,
        status: "cancelled",
        taskId: task.taskId,
      });

      emitAgentEvent({
        data: {
          endedAt: 999,
          phase: "end",
        },
        runId: "run-cancel-then-end",
        stream: "lifecycle",
      });
      emitAgentEvent({
        data: {
          error: "late error",
        },
        runId: "run-cancel-then-end",
        stream: "error",
      });

      expect(findTaskByRunId("run-cancel-then-end")).toMatchObject({
        endedAt: 200,
        error: "Cancelled by operator.",
        lastEventAt: 200,
        status: "cancelled",
      });
    });
  });

  it("summarizes task pressure by status and runtime", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-summary-acp",
        runtime: "acp",
        scopeKind: "session",
        status: "queued",
        task: "Investigate issue",
      });
      createTaskRecord({
        deliveryStatus: "not_applicable",
        ownerKey: "",
        runId: "run-summary-cron",
        runtime: "cron",
        scopeKind: "system",
        status: "running",
        task: "Daily digest",
      });
      createTaskRecord({
        deliveryStatus: "session_queued",
        ownerKey: "agent:main:main",
        runId: "run-summary-subagent",
        runtime: "subagent",
        scopeKind: "session",
        status: "timed_out",
        task: "Write patch",
      });

      expect(getTaskRegistrySummary()).toEqual({
        active: 2,
        byRuntime: {
          acp: 1,
          cli: 0,
          cron: 1,
          subagent: 1,
        },
        byStatus: {
          cancelled: 0,
          failed: 0,
          lost: 0,
          queued: 1,
          running: 1,
          succeeded: 0,
          timed_out: 1,
        },
        failures: 1,
        terminal: 1,
        total: 3,
      });
    });
  });

  it("rejects cross-owner parent flow links during task creation", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const flow = createManagedTaskFlow({
        controllerId: "tests/task-registry",
        goal: "Owner main flow",
        ownerKey: "agent:main:main",
      });

      expect(() =>
        createTaskRecord({
          ownerKey: "agent:main:other",
          parentFlowId: flow.flowId,
          runId: "cross-owner-run",
          runtime: "acp",
          scopeKind: "session",
          task: "Attempt hijack",
        }),
      ).toThrow("Task ownerKey must match parent flow ownerKey.");
    });
  });

  it("rejects system-scoped parent flow links during task creation", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const flow = createManagedTaskFlow({
        controllerId: "tests/task-registry",
        goal: "Owner main flow",
        ownerKey: "agent:main:main",
      });

      expect(() =>
        createTaskRecord({
          deliveryStatus: "not_applicable",
          ownerKey: "agent:main:main",
          parentFlowId: flow.flowId,
          runId: "system-link-run",
          runtime: "cron",
          scopeKind: "system",
          task: "System task",
        }),
      ).toThrow("Only session-scoped tasks can link to flows.");
    });
  });

  it("rejects cross-owner flow links for existing tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const task = createTaskRecord({
        ownerKey: "agent:main:main",
        runId: "owner-main-task",
        runtime: "acp",
        scopeKind: "session",
        task: "Safe task",
      });
      const flow = createManagedTaskFlow({
        controllerId: "tests/task-registry",
        goal: "Other owner flow",
        ownerKey: "agent:main:other",
      });

      expect(() =>
        linkTaskToFlowById({
          flowId: flow.flowId,
          taskId: task.taskId,
        }),
      ).toThrow("Task ownerKey must match parent flow ownerKey.");
      expect(getTaskById(task.taskId)).toMatchObject({
        parentFlowId: undefined,
        taskId: task.taskId,
      });
    });
  });

  it("rejects parent flow links once cancellation has been requested", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const flow = createManagedTaskFlow({
        cancelRequestedAt: 42,
        controllerId: "tests/task-registry",
        goal: "Cancelling flow",
        ownerKey: "agent:main:main",
      });

      try {
        createTaskRecord({
          ownerKey: "agent:main:main",
          parentFlowId: flow.flowId,
          runId: "cancel-requested-link",
          runtime: "acp",
          scopeKind: "session",
          task: "Should be denied",
        });
        throw new Error("Expected createTaskRecord to throw.");
      } catch (error) {
        expect(isParentFlowLinkError(error)).toBe(true);
        expect(error).toMatchObject({
          code: "cancel_requested",
          message: "Parent flow cancellation has already been requested.",
        });
      }
    });
  });

  it("rejects parent flow links for terminal flows", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureInMemoryTaskStoresForLinkValidationTests();

      const flow = createManagedTaskFlow({
        controllerId: "tests/task-registry",
        goal: "Completed flow",
        ownerKey: "agent:main:main",
        status: "cancelled",
      });

      expect(() =>
        createTaskRecord({
          ownerKey: "agent:main:main",
          parentFlowId: flow.flowId,
          runId: "terminal-flow-link",
          runtime: "acp",
          scopeKind: "session",
          task: "Should be denied",
        }),
      ).toThrow("Parent flow is already cancelled.");
    });
  });

  it("delivers ACP completion to the requester channel when a delivery origin exists", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          threadId: "321",
          to: "telegram:123",
        },
        runId: "run-delivery",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 100,
        status: "running",
        task: "Investigate issue",
      });

      emitAgentEvent({
        data: {
          endedAt: 250,
          phase: "end",
        },
        runId: "run-delivery",
        stream: "lifecycle",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-delivery")).toMatchObject({
          deliveryStatus: "delivered",
          status: "succeeded",
        }),
      );
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "telegram",
            content: expect.stringContaining("Background task done: ACP background task"),
            mirror: expect.objectContaining({
              sessionKey: "agent:main:main",
            }),
            threadId: "321",
            to: "telegram:123",
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("records delivery failure and queues a session fallback when direct delivery misses", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockRejectedValueOnce(new Error("telegram unavailable"));

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-delivery-fail",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 100,
        status: "running",
        task: "Investigate issue",
      });

      emitAgentEvent({
        data: {
          endedAt: 250,
          error: "Permission denied by ACP runtime",
          phase: "error",
        },
        runId: "run-delivery-fail",
        stream: "lifecycle",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-delivery-fail")).toMatchObject({
          deliveryStatus: "failed",
          error: "Permission denied by ACP runtime",
          status: "failed",
        }),
      );
      await waitForAssertion(() =>
        expect(peekSystemEvents("agent:main:main")).toEqual([
          expect.stringContaining("Background task failed: ACP background task"),
        ]),
      );
    });
  });

  it("still wakes the parent when blocked delivery misses the outward channel", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockRejectedValueOnce(new Error("telegram unavailable"));

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-delivery-blocked",
        runtime: "acp",
        scopeKind: "session",
        status: "succeeded",
        task: "Port the repo changes",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-delivery-blocked")).toMatchObject({
          deliveryStatus: "failed",
          status: "succeeded",
          terminalOutcome: "blocked",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task blocked: ACP background task (run run-deli). Writable session or apply_patch authorization required.",
        "Task needs follow-up: ACP background task (run run-deli). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
    });
  });

  it("marks internal fallback delivery as session queued instead of delivered", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-session-queued",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 100,
        status: "running",
        task: "Investigate issue",
      });

      emitAgentEvent({
        data: {
          endedAt: 250,
          phase: "end",
        },
        runId: "run-session-queued",
        stream: "lifecycle",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-session-queued")).toMatchObject({
          deliveryStatus: "session_queued",
          status: "succeeded",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        expect.stringContaining("Background task done: ACP background task"),
      ]);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("wakes the parent for blocked tasks even when delivery falls back to the session", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-session-blocked",
        runtime: "acp",
        scopeKind: "session",
        status: "succeeded",
        task: "Port the repo changes",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(findTaskByRunId("run-session-blocked")).toMatchObject({
          deliveryStatus: "session_queued",
          status: "succeeded",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Background task blocked: ACP background task (run run-sess). Writable session or apply_patch authorization required.",
        "Task needs follow-up: ACP background task (run run-sess). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();
    });
  });

  it("does not include internal progress detail in the terminal channel message", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          threadId: "321",
          to: "telegram:123",
        },
        runId: "run-detail-leak",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 100,
        status: "running",
        task: "Create the file and verify it",
      });

      setTaskProgressById({
        progressSummary:
          "I am loading the local session context and checking helper command availability before writing the file.",
        taskId: findTaskByRunId("run-detail-leak")!.taskId,
      });

      emitAgentEvent({
        data: {
          endedAt: 250,
          phase: "end",
        },
        runId: "run-detail-leak",
        stream: "lifecycle",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content: "Background task done: ACP background task (run run-deta).",
          }),
        ),
      );
    });
  });

  it("surfaces blocked outcomes separately from completed tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-blocked-outcome",
        runtime: "acp",
        scopeKind: "session",
        status: "succeeded",
        task: "Port the repo changes",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task blocked: ACP background task (run run-bloc). Writable session or apply_patch authorization required.",
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([
        "Task needs follow-up: ACP background task (run run-bloc). Writable session or apply_patch authorization required.",
      ]);
      expect(hasPendingHeartbeatWake()).toBe(true);
    });
  });

  it("does not queue an unblock follow-up for ordinary completed tasks", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-succeeded-outcome",
        runtime: "acp",
        scopeKind: "session",
        status: "succeeded",
        task: "Create the file and verify it",
        terminalOutcome: "succeeded",
        terminalSummary: "Created /tmp/file.txt and verified contents.",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task done: ACP background task (run run-succ). Created /tmp/file.txt and verified contents.",
          }),
        ),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      expect(hasPendingHeartbeatWake()).toBe(false);
    });
  });

  it("keeps distinct task records when different producers share a runId", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      createTaskRecord({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "not_applicable",
        ownerKey: "agent:codex:acp:child",
        runId: "run-shared",
        runtime: "cli",
        scopeKind: "session",
        status: "running",
        task: "Child ACP execution",
      });

      createTaskRecord({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-shared",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Spawn ACP child",
      });

      expect(listTaskRecords().filter((task) => task.runId === "run-shared")).toHaveLength(2);
      expect(findTaskByRunId("run-shared")).toMatchObject({
        runtime: "acp",
        task: "Spawn ACP child",
      });
    });
  });

  it("scopes shared-run lifecycle events to the matching session", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const victimTask = createTaskRecord({
        childSessionKey: "agent:victim:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:victim:main",
        runId: "run-shared-scope",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Victim ACP task",
      });

      const attackerTask = createTaskRecord({
        childSessionKey: "agent:attacker:main",
        deliveryStatus: "not_applicable",
        ownerKey: "agent:attacker:main",
        runId: "run-shared-scope",
        runtime: "cli",
        scopeKind: "session",
        status: "running",
        task: "Attacker CLI task",
      });

      registerAgentRunContext("run-shared-scope", {
        sessionKey: "agent:attacker:main",
      });
      emitAgentEvent({
        data: {
          endedAt: 250,
          error: "attacker controlled error",
          phase: "error",
        },
        runId: "run-shared-scope",
        stream: "lifecycle",
      });

      expect(getTaskById(attackerTask.taskId)).toMatchObject({
        error: "attacker controlled error",
        status: "failed",
      });
      expect(getTaskById(victimTask.taskId)).toMatchObject({
        status: "running",
      });
      expect(getTaskById(victimTask.taskId)).not.toHaveProperty("error");
    });
  });

  it("suppresses duplicate ACP delivery when a preferred spawned task shares the runId", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      const directTask = createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-shared-delivery",
        runtime: "acp",
        scopeKind: "session",
        status: "succeeded",
        task: "Direct ACP child",
      });
      const spawnedTask = createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        preferMetadata: true,
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-shared-delivery",
        runtime: "acp",
        scopeKind: "session",
        status: "succeeded",
        task: "Spawn ACP child",
      });

      await maybeDeliverTaskTerminalUpdate(directTask.taskId);
      await maybeDeliverTaskTerminalUpdate(spawnedTask.taskId);

      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
      expect(listTaskRecords().filter((task) => task.runId === "run-shared-delivery")).toHaveLength(
        1,
      );
      expect(findTaskByRunId("run-shared-delivery")).toMatchObject({
        deliveryStatus: "delivered",
        task: "Spawn ACP child",
        taskId: directTask.taskId,
      });
    });
  });

  it("does not suppress ACP delivery across different requester scopes when runIds collide", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const victimTask = createTaskRecord({
        childSessionKey: "agent:victim:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:victim:main",
        runId: "run-cross-requester-delivery",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Victim ACP task",
      });
      const attackerTask = createTaskRecord({
        childSessionKey: "agent:attacker:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:attacker:main",
        runId: "run-cross-requester-delivery",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Attacker ACP task",
      });

      markTaskTerminalById({
        endedAt: 250,
        status: "succeeded",
        taskId: victimTask.taskId,
      });
      markTaskTerminalById({
        endedAt: 260,
        status: "succeeded",
        taskId: attackerTask.taskId,
      });
      await maybeDeliverTaskTerminalUpdate(victimTask.taskId);
      await maybeDeliverTaskTerminalUpdate(attackerTask.taskId);

      await waitForAssertion(() =>
        expect(getTaskById(victimTask.taskId)).toMatchObject({
          deliveryStatus: "session_queued",
        }),
      );
      await waitForAssertion(() =>
        expect(getTaskById(attackerTask.taskId)).toMatchObject({
          deliveryStatus: "session_queued",
        }),
      );
    });
  });

  it("adopts preferred ACP spawn metadata when collapsing onto an earlier direct record", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const directTask = createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-collapse-preferred",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Direct ACP child",
      });

      const spawnedTask = createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        label: "Quant patch",
        ownerKey: "agent:main:main",
        preferMetadata: true,
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-collapse-preferred",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Implement the feature and report back",
      });

      expect(spawnedTask.taskId).toBe(directTask.taskId);
      expect(findTaskByRunId("run-collapse-preferred")).toMatchObject({
        label: "Quant patch",
        task: "Implement the feature and report back",
        taskId: directTask.taskId,
      });
    });
  });

  it("collapses ACP run-owned task creation onto the existing spawned task", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const spawnedTask = createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-collapse",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Spawn ACP child",
      });

      const directTask = createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-collapse",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Direct ACP child",
      });

      expect(directTask.taskId).toBe(spawnedTask.taskId);
      expect(listTaskRecords().filter((task) => task.runId === "run-collapse")).toHaveLength(1);
      expect(findTaskByRunId("run-collapse")).toMatchObject({
        task: "Spawn ACP child",
      });
    });
  });

  it("delivers a terminal ACP update only once when multiple notifiers race", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "telegram",
        to: "telegram:123",
        via: "direct",
      });

      const task = createTaskRecord({
        childSessionKey: "agent:main:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-racing-delivery",
        runtime: "acp",
        scopeKind: "session",
        status: "succeeded",
        task: "Investigate issue",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session or apply_patch authorization required.",
      });

      const first = maybeDeliverTaskTerminalUpdate(task.taskId);
      const second = maybeDeliverTaskTerminalUpdate(task.taskId);
      await Promise.all([first, second]);

      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `task-terminal:${task.taskId}:succeeded:blocked`,
          mirror: expect.objectContaining({
            idempotencyKey: `task-terminal:${task.taskId}:succeeded:blocked`,
          }),
        }),
      );
      expect(findTaskByRunId("run-racing-delivery")).toMatchObject({
        deliveryStatus: "delivered",
      });
    });
  });

  it("restores persisted tasks from disk on the next lookup", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        childSessionKey: "agent:main:subagent:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-restore",
        runtime: "subagent",
        scopeKind: "session",
        status: "running",
        task: "Restore me",
      });

      resetTaskRegistryForTests({
        persist: false,
      });

      expect(resolveTaskForLookupToken(task.taskId)).toMatchObject({
        runId: "run-restore",
        task: "Restore me",
        taskId: task.taskId,
      });
    });
  });

  it("indexes tasks by session key for latest and list lookups", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests({ persist: false });
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1_700_000_000_000);

      const older = createTaskRecord({
        childSessionKey: "agent:main:subagent:child-1",
        ownerKey: "agent:main:main",
        runId: "run-session-lookup-1",
        runtime: "acp",
        scopeKind: "session",
        task: "Older task",
      });
      const latest = createTaskRecord({
        childSessionKey: "agent:main:subagent:child-2",
        ownerKey: "agent:main:main",
        runId: "run-session-lookup-2",
        runtime: "subagent",
        scopeKind: "session",
        task: "Latest task",
      });
      nowSpy.mockRestore();

      expect(findLatestTaskForOwnerKey("agent:main:main")?.taskId).toBe(latest.taskId);
      expect(listTasksForOwnerKey("agent:main:main").map((task) => task.taskId)).toEqual([
        latest.taskId,
        older.taskId,
      ]);
      expect(findLatestTaskForRelatedSessionKey("agent:main:subagent:child-1")?.taskId).toBe(
        older.taskId,
      );
    });
  });

  it("projects inspection-time orphaned tasks as lost without mutating the registry", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        childSessionKey: "agent:main:acp:missing",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-lost",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Missing child",
      });
      setTaskTimingById({
        lastEventAt: Date.now() - 10 * 60_000,
        taskId: task.taskId,
      });

      const tasks = reconcileInspectableTasks();
      expect(tasks[0]).toMatchObject({
        error: "backing session missing",
        runId: "run-lost",
        status: "lost",
      });
      expect(getTaskById(task.taskId)).toMatchObject({
        status: "running",
      });
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("marks orphaned tasks lost with cleanupAfter in a single maintenance pass", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();

      const task = createTaskRecord({
        childSessionKey: "agent:main:acp:missing",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-lost-maintenance",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Missing child",
      });
      setTaskTimingById({
        lastEventAt: now - 10 * 60_000,
        taskId: task.taskId,
      });

      expect(await runTaskRegistryMaintenance()).toEqual({
        cleanupStamped: 0,
        pruned: 0,
        reconciled: 1,
      });
      expect(getTaskById(task.taskId)).toMatchObject({
        error: "backing session missing",
        status: "lost",
      });
      expect(getTaskById(task.taskId)?.cleanupAfter).toBeGreaterThan(now);
    });
  });

  it("prunes old terminal tasks during maintenance sweeps", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();

      const task = createTaskRecord({
        childSessionKey: "agent:main:main",
        deliveryStatus: "not_applicable",
        ownerKey: "agent:main:main",
        runId: "run-prune",
        runtime: "cli",
        scopeKind: "session",
        startedAt: Date.now() - 9 * 24 * 60 * 60_000,
        status: "succeeded",
        task: "Old completed task",
      });
      setTaskTimingById({
        endedAt: Date.now() - 8 * 24 * 60 * 60_000,
        lastEventAt: Date.now() - 8 * 24 * 60 * 60_000,
        taskId: task.taskId,
      });

      expect(await sweepTaskRegistry()).toEqual({
        cleanupStamped: 0,
        pruned: 1,
        reconciled: 0,
      });
      expect(listTaskRecords()).toEqual([]);
    });
  });

  it("previews and repairs missing cleanup timestamps during maintenance", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            deliveryStates: new Map(),
            tasks: new Map([
              [
                "task-missing-cleanup",
                {
                  createdAt: now - 120_000,
                  deliveryStatus: "not_applicable",
                  endedAt: now - 60_000,
                  lastEventAt: now - 60_000,
                  notifyPolicy: "silent",
                  ownerKey: "system:cron:task-missing-cleanup",
                  requesterSessionKey: "",
                  runId: "run-maintenance-cleanup",
                  runtime: "cron",
                  scopeKind: "system",
                  status: "failed",
                  task: "Finished cron",
                  taskId: "task-missing-cleanup",
                },
              ],
            ]),
          }),
          saveSnapshot: () => {},
        },
      });

      expect(previewTaskRegistryMaintenance()).toEqual({
        cleanupStamped: 1,
        pruned: 0,
        reconciled: 0,
      });

      expect(await runTaskRegistryMaintenance()).toEqual({
        cleanupStamped: 1,
        pruned: 0,
        reconciled: 0,
      });
      expect(getTaskById("task-missing-cleanup")?.cleanupAfter).toBeGreaterThan(now);
    });
  });

  it("cancels the deferred maintenance sweep during test teardown", async () => {
    await withTaskRegistryTempDir(async (root) => {
      vi.useFakeTimers();
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();

      const task = createTaskRecord({
        childSessionKey: "agent:main:acp:missing",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-deferred-maintenance-stop",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Missing child",
      });
      setTaskTimingById({
        lastEventAt: now - 10 * 60_000,
        taskId: task.taskId,
      });

      startTaskRegistryMaintenance();
      stopTaskRegistryMaintenanceForTests();

      await vi.advanceTimersByTimeAsync(5000);
      await flushAsyncWork();

      expect(getTaskById(task.taskId)).toMatchObject({
        status: "running",
      });
    });
  });

  it("rechecks current task state before marking a task lost", async () => {
    const now = Date.now();
    const snapshotTask = createTaskRecord({
      childSessionKey: "agent:main:acp:missing-stale",
      deliveryStatus: "pending",
      ownerKey: "agent:main:main",
      runId: "run-lost-stale",
      runtime: "acp",
      scopeKind: "session",
      status: "running",
      task: "Missing child",
    });
    const staleTask = {
      ...snapshotTask,
      lastEventAt: now - 10 * 60_000,
    };
    const currentTask = {
      ...snapshotTask,
      lastEventAt: now,
    };
    const currentTasks = new Map([[snapshotTask.taskId, currentTask]]);
    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks,
      snapshotTasks: [staleTask],
    });

    expect(await runTaskRegistryMaintenance()).toEqual({
      cleanupStamped: 0,
      pruned: 0,
      reconciled: 0,
    });
    expect(currentTasks.get(snapshotTask.taskId)).toMatchObject({
      lastEventAt: now,
      status: "running",
    });
  });

  it("rechecks current task state before pruning a task", async () => {
    const now = Date.now();
    const snapshotTask = createTaskRecord({
      childSessionKey: "agent:main:main",
      deliveryStatus: "not_applicable",
      ownerKey: "agent:main:main",
      runId: "run-prune-stale",
      runtime: "cli",
      scopeKind: "session",
      startedAt: now - 9 * 24 * 60 * 60_000,
      status: "succeeded",
      task: "Old completed task",
    });
    const staleTask = {
      ...snapshotTask,
      cleanupAfter: now - 1,
      endedAt: now - 8 * 24 * 60 * 60_000,
      lastEventAt: now - 8 * 24 * 60 * 60_000,
    };
    const currentTask = {
      ...staleTask,
      cleanupAfter: now + 60_000,
    };
    const currentTasks = new Map([[snapshotTask.taskId, currentTask]]);
    configureTaskRegistryMaintenanceRuntimeForTest({
      currentTasks,
      snapshotTasks: [staleTask],
    });

    expect(await sweepTaskRegistry()).toEqual({
      cleanupStamped: 0,
      pruned: 0,
      reconciled: 0,
    });
    expect(currentTasks.get(snapshotTask.taskId)).toMatchObject({
      cleanupAfter: now + 60_000,
      status: "succeeded",
    });
  });

  it("summarizes inspectable task audit findings", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      const now = Date.now();
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({
            deliveryStates: new Map(),
            tasks: new Map([
              [
                "task-audit-summary",
                {
                  createdAt: now - 50 * 60_000,
                  deliveryStatus: "pending",
                  lastEventAt: now - 40 * 60_000,
                  notifyPolicy: "done_only",
                  ownerKey: "agent:main:main",
                  requesterSessionKey: "agent:main:main",
                  runId: "run-audit-summary",
                  runtime: "acp",
                  scopeKind: "session",
                  startedAt: now - 40 * 60_000,
                  status: "running",
                  task: "Hung task",
                  taskId: "task-audit-summary",
                },
              ],
            ]),
          }),
          saveSnapshot: () => {},
        },
      });

      expect(getInspectableTaskAuditSummary()).toEqual({
        byCode: {
          delivery_failed: 0,
          inconsistent_timestamps: 0,
          lost: 0,
          missing_cleanup: 0,
          stale_queued: 0,
          stale_running: 1,
        },
        errors: 1,
        total: 1,
        warnings: 0,
      });
    });
  });

  it("delivers concise state-change updates only when notify policy requests them", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:123",
        via: "direct",
      });

      const task = createTaskRecord({
        childSessionKey: "agent:codex:acp:child",
        notifyPolicy: "done_only",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          to: "discord:123",
        },
        runId: "run-state-change",
        runtime: "acp",
        scopeKind: "session",
        status: "queued",
        task: "Investigate issue",
      });

      markTaskRunningByRunId({
        eventSummary: "Started.",
        runId: "run-state-change",
      });
      await waitForAssertion(() => expect(hoisted.sendMessageMock).not.toHaveBeenCalled());

      updateTaskNotifyPolicyById({
        notifyPolicy: "state_changes",
        taskId: task.taskId,
      });
      recordTaskProgressByRunId({
        eventSummary: "No output for 60s. It may be waiting for input.",
        runId: "run-state-change",
      });

      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Background task update: ACP background task. No output for 60s. It may be waiting for input.",
          }),
        ),
      );
      expect(findTaskByRunId("run-state-change")).toMatchObject({
        notifyPolicy: "state_changes",
      });
      await maybeDeliverTaskStateChangeUpdate(task.taskId);
      expect(hoisted.sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps background ACP progress off the foreground lane and only sends a terminal notify", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:123",
        via: "direct",
      });
      vi.useFakeTimers();

      createTaskRecord({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          to: "discord:123",
        },
        runId: "run-quiet-terminal",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Create the file",
      });

      const relay = startAcpSpawnParentStreamRelay({
        agentId: "codex",
        childSessionKey: "agent:codex:acp:child",
        noOutputNoticeMs: 1000,
        noOutputPollMs: 250,
        parentSessionKey: "agent:main:main",
        runId: "run-quiet-terminal",
        streamFlushMs: 1,
        surfaceUpdates: false,
      });

      relay.notifyStarted();
      emitAgentEvent({
        data: {
          delta: "working on it",
        },
        runId: "run-quiet-terminal",
        stream: "assistant",
      });
      vi.advanceTimersByTime(10);

      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      expect(hoisted.sendMessageMock).not.toHaveBeenCalled();

      emitAgentEvent({
        data: {
          endedAt: 250,
          phase: "end",
        },
        runId: "run-quiet-terminal",
        stream: "lifecycle",
      });
      await flushAsyncWork();

      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          content: "Background task done: ACP background task (run run-quie).",
          to: "discord:123",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      relay.dispose();
      vi.useRealTimers();
    });
  });

  it("delivers a concise terminal failure message without internal ACP chatter", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:123",
        via: "direct",
      });

      createTaskRecord({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        progressSummary:
          "I am loading session context and checking helper availability before writing the file.",
        requesterOrigin: {
          channel: "discord",
          to: "discord:123",
        },
        runId: "run-failure-terminal",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Write the file",
      });

      emitAgentEvent({
        data: {
          endedAt: 250,
          error: "Permission denied by ACP runtime",
          phase: "error",
        },
        runId: "run-failure-terminal",
        stream: "lifecycle",
      });
      await flushAsyncWork();

      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          content:
            "Background task failed: ACP background task (run run-fail). Permission denied by ACP runtime",
          to: "discord:123",
        }),
      );
      expect(peekSystemEvents("agent:main:main")).toEqual([]);
    });
  });

  it("emits concise state-change updates without surfacing raw ACP chatter", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskRegistryForTests();
      resetSystemEventsForTest();
      hoisted.sendMessageMock.mockResolvedValue({
        channel: "discord",
        to: "discord:123",
        via: "direct",
      });
      vi.useFakeTimers();

      createTaskRecord({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "pending",
        notifyPolicy: "state_changes",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          to: "discord:123",
        },
        runId: "run-state-stream",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Create the file",
      });

      const relay = startAcpSpawnParentStreamRelay({
        agentId: "codex",
        childSessionKey: "agent:codex:acp:child",
        noOutputNoticeMs: 1000,
        noOutputPollMs: 250,
        parentSessionKey: "agent:main:main",
        runId: "run-state-stream",
        streamFlushMs: 1,
        surfaceUpdates: false,
      });

      relay.notifyStarted();
      await flushAsyncWork();
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Background task update: ACP background task. Started.",
        }),
      );

      hoisted.sendMessageMock.mockClear();
      vi.advanceTimersByTime(1500);
      await flushAsyncWork();
      expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            "Background task update: ACP background task. No output for 1s. It may be waiting for input.",
        }),
      );

      expect(peekSystemEvents("agent:main:main")).toEqual([]);
      relay.dispose();
      vi.useRealTimers();
    });
  });

  it("cancels ACP-backed tasks through the ACP session manager", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const task = createTaskRecord({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-cancel-acp",
        runtime: "acp",
        scopeKind: "session",
        status: "running",
        task: "Investigate issue",
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(hoisted.cancelSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: {},
          reason: "task-cancel",
          sessionKey: "agent:codex:acp:child",
        }),
      );
      expect(result).toMatchObject({
        cancelled: true,
        found: true,
        task: expect.objectContaining({
          error: "Cancelled by operator.",
          status: "cancelled",
          taskId: task.taskId,
        }),
      });
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "telegram",
            content: "Background task cancelled: ACP background task (run run-canc).",
            to: "telegram:123",
          }),
        ),
      );
    });
  });

  it("cancels subagent-backed tasks through subagent control", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      hoisted.killSubagentRunAdminMock.mockResolvedValue({
        found: true,
        killed: true,
      });

      const task = createTaskRecord({
        childSessionKey: "agent:worker:subagent:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-cancel-subagent",
        runtime: "subagent",
        scopeKind: "session",
        status: "running",
        task: "Investigate issue",
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: {},
          sessionKey: "agent:worker:subagent:child",
        }),
      );
      expect(result).toMatchObject({
        cancelled: true,
        found: true,
        task: expect.objectContaining({
          error: "Cancelled by operator.",
          status: "cancelled",
          taskId: task.taskId,
        }),
      });
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "telegram",
            content: "Background task cancelled: Subagent task (run run-canc).",
            to: "telegram:123",
          }),
        ),
      );
    });
  });

  it("cancels CLI-tracked tasks in the registry without ACP or subagent teardown", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      hoisted.cancelSessionMock.mockClear();
      hoisted.killSubagentRunAdminMock.mockClear();

      const task = createTaskRecord({
        childSessionKey: "agent:main:main",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-cancel-cli",
        runtime: "cli",
        scopeKind: "session",
        status: "running",
        task: "Investigate issue",
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(hoisted.cancelSessionMock).not.toHaveBeenCalled();
      expect(hoisted.killSubagentRunAdminMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        cancelled: true,
        found: true,
        task: expect.objectContaining({
          error: "Cancelled by operator.",
          status: "cancelled",
          taskId: task.taskId,
        }),
      });
      await waitForAssertion(() =>
        expect(hoisted.sendMessageMock).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "telegram",
            content: "Background task cancelled: Investigate issue (run run-canc).",
            to: "telegram:123",
          }),
        ),
      );
    });
  });

  it("cancels CLI-tracked tasks without childSessionKey", async () => {
    await withTaskRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      const task = createTaskRecord({
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-cli-no-child",
        runtime: "cli",
        scopeKind: "session",
        status: "running",
        task: "Legacy row",
      });

      const result = await cancelTaskById({
        cfg: {} as never,
        taskId: task.taskId,
      });

      expect(result).toMatchObject({
        cancelled: true,
        found: true,
        task: expect.objectContaining({
          status: "cancelled",
          taskId: task.taskId,
        }),
      });
    });
  });
});
