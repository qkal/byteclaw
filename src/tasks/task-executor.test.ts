import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resetHeartbeatWakeStateForTests } from "../infra/heartbeat-wake.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  cancelDetachedTaskRunById,
  cancelFlowById,
  cancelFlowByIdForOwner,
  completeTaskRunByRunId,
  createQueuedTaskRun,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  retryBlockedFlowAsQueuedTaskRun,
  runTaskInFlow,
  runTaskInFlowForOwner,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "./task-executor.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import {
  findLatestTaskForFlowId,
  findTaskByRunId,
  getTaskById,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "./task-registry.js";

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

async function withTaskExecutorStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  await withStateDirEnv("openclaw-task-executor-", async ({ stateDir }) => {
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage: hoisted.sendMessageMock,
    });
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetAgentEventsForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetAgentRunContextForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      await run(stateDir);
    } finally {
      resetSystemEventsForTest();
      resetHeartbeatWakeStateForTests();
      resetAgentEventsForTest();
      resetTaskRegistryDeliveryRuntimeForTests();
      resetAgentRunContextForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

describe("task-executor", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
    resetAgentEventsForTest();
    resetTaskRegistryDeliveryRuntimeForTests();
    resetAgentRunContextForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    hoisted.sendMessageMock.mockReset();
    hoisted.cancelSessionMock.mockReset();
    hoisted.killSubagentRunAdminMock.mockReset();
  });

  it("advances a queued run through start and completion", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createQueuedTaskRun({
        childSessionKey: "agent:codex:acp:child",
        ownerKey: "agent:main:main",
        runId: "run-executor-queued",
        runtime: "acp",
        scopeKind: "session",
        task: "Investigate issue",
      });

      expect(created.status).toBe("queued");

      startTaskRunByRunId({
        eventSummary: "Started.",
        lastEventAt: 100,
        runId: "run-executor-queued",
        startedAt: 100,
      });

      completeTaskRunByRunId({
        endedAt: 250,
        lastEventAt: 250,
        runId: "run-executor-queued",
        terminalSummary: "Done.",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        endedAt: 250,
        startedAt: 100,
        status: "succeeded",
        taskId: created.taskId,
        terminalSummary: "Done.",
      });
    });
  });

  it("records progress, failure, and delivery status through the executor", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        childSessionKey: "agent:codex:subagent:child",
        ownerKey: "agent:main:main",
        runId: "run-executor-fail",
        runtime: "subagent",
        scopeKind: "session",
        startedAt: 10,
        task: "Write summary",
      });

      recordTaskRunProgressByRunId({
        eventSummary: "Collecting results",
        lastEventAt: 20,
        progressSummary: "Collecting results",
        runId: "run-executor-fail",
      });

      failTaskRunByRunId({
        endedAt: 40,
        error: "tool failed",
        lastEventAt: 40,
        runId: "run-executor-fail",
      });

      setDetachedTaskDeliveryStatusByRunId({
        deliveryStatus: "failed",
        runId: "run-executor-fail",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        deliveryStatus: "failed",
        error: "tool failed",
        progressSummary: "Collecting results",
        status: "failed",
        taskId: created.taskId,
      });
    });
  });

  it("persists explicit task kind metadata on created runs", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        childSessionKey: "agent:main:main",
        deliveryStatus: "not_applicable",
        ownerKey: "agent:main:main",
        runId: "run-executor-kind",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "video_generate:openai",
        startedAt: 10,
        task: "Generate lobster video",
        taskKind: "video_generation",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        sourceId: "video_generate:openai",
        taskId: created.taskId,
        taskKind: "video_generation",
      });
      expect(findTaskByRunId("run-executor-kind")).toMatchObject({
        taskId: created.taskId,
        taskKind: "video_generation",
      });
    });
  });

  it("auto-creates a one-task flow and keeps it synced with task status", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        childSessionKey: "agent:codex:subagent:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-executor-flow",
        runtime: "subagent",
        scopeKind: "session",
        startedAt: 10,
        task: "Write summary",
      });

      expect(created.parentFlowId).toEqual(expect.any(String));
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        goal: "Write summary",
        notifyPolicy: "done_only",
        ownerKey: "agent:main:main",
        status: "running",
      });

      completeTaskRunByRunId({
        endedAt: 40,
        lastEventAt: 40,
        runId: "run-executor-flow",
        terminalSummary: "Done.",
      });

      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        endedAt: 40,
        flowId: created.parentFlowId,
        goal: "Write summary",
        notifyPolicy: "done_only",
        status: "succeeded",
      });
    });
  });

  it("does not auto-create one-task flows for non-returning bookkeeping runs", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        childSessionKey: "agent:main:main",
        deliveryStatus: "not_applicable",
        ownerKey: "agent:main:main",
        runId: "run-executor-cli",
        runtime: "cli",
        scopeKind: "session",
        startedAt: 10,
        task: "Foreground gateway run",
      });

      expect(created.parentFlowId).toBeUndefined();
      expect(listTaskFlowRecords()).toEqual([]);
    });
  });

  it("records blocked metadata on one-task flows and reuses the same flow for queued retries", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
        runId: "run-executor-blocked",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 10,
        task: "Patch file",
      });

      completeTaskRunByRunId({
        endedAt: 40,
        lastEventAt: 40,
        runId: "run-executor-blocked",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });

      expect(getTaskById(created.taskId)).toMatchObject({
        status: "succeeded",
        taskId: created.taskId,
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        blockedSummary: "Writable session required.",
        blockedTaskId: created.taskId,
        endedAt: 40,
        flowId: created.parentFlowId,
        status: "blocked",
      });

      const retried = retryBlockedFlowAsQueuedTaskRun({
        childSessionKey: "agent:codex:acp:retry-child",
        flowId: created.parentFlowId!,
        runId: "run-executor-retry",
      });

      expect(retried).toMatchObject({
        found: true,
        previousTask: expect.objectContaining({
          taskId: created.taskId,
        }),
        retried: true,
        task: expect.objectContaining({
          parentFlowId: created.parentFlowId,
          parentTaskId: created.taskId,
          runId: "run-executor-retry",
          status: "queued",
        }),
      });
      expect(getTaskFlowById(created.parentFlowId!)).toMatchObject({
        flowId: created.parentFlowId,
        status: "queued",
      });
      expect(findLatestTaskForFlowId(created.parentFlowId!)).toMatchObject({
        runId: "run-executor-retry",
      });
      expect(findTaskByRunId("run-executor-blocked")).toMatchObject({
        status: "succeeded",
        taskId: created.taskId,
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });
    });
  });

  it("cancels active tasks linked to a managed TaskFlow", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const flow = createManagedTaskFlow({
        controllerId: "tests/managed-flow",
        goal: "Inspect PR batch",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
      });
      const child = createRunningTaskRun({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        parentFlowId: flow.flowId,
        runId: "run-linear-cancel",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 10,
        task: "Inspect a PR",
      });

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        cancelled: true,
        found: true,
      });
      expect(findTaskByRunId("run-linear-cancel")).toMatchObject({
        status: "cancelled",
        taskId: child.taskId,
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "cancelled",
      });
    });
  });

  it("runs child tasks under managed TaskFlows", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        controllerId: "tests/managed-flow",
        goal: "Inspect PR batch",
        ownerKey: "agent:main:main",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:123",
        },
      });

      const created = runTaskInFlow({
        childSessionKey: "agent:codex:acp:child",
        flowId: flow.flowId,
        label: "Inspect a PR",
        lastEventAt: 10,
        runId: "run-flow-child",
        runtime: "acp",
        startedAt: 10,
        status: "running",
        task: "Inspect a PR",
      });

      expect(created).toMatchObject({
        created: true,
        found: true,
        task: expect.objectContaining({
          ownerKey: "agent:main:main",
          parentFlowId: flow.flowId,
          runId: "run-flow-child",
          status: "running",
        }),
      });
      expect(getTaskById(created.task!.taskId)).toMatchObject({
        childSessionKey: "agent:codex:acp:child",
        ownerKey: "agent:main:main",
        parentFlowId: flow.flowId,
      });
    });
  });

  it("refuses to add child tasks once cancellation is requested on a managed TaskFlow", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
        ownerKey: "agent:main:main",
      });

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        cancelled: true,
        found: true,
      });

      const created = runTaskInFlow({
        childSessionKey: "agent:codex:acp:child",
        flowId: flow.flowId,
        runId: "run-flow-after-cancel",
        runtime: "acp",
        task: "Should be denied",
      });

      expect(created).toMatchObject({
        created: false,
        found: true,
        reason: "Flow cancellation has already been requested.",
      });
    });
  });

  it("sets cancel intent before child tasks settle and finalizes later", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockRejectedValue(new Error("still shutting down"));

      const flow = createManagedTaskFlow({
        controllerId: "tests/managed-flow",
        goal: "Long running batch",
        ownerKey: "agent:main:main",
      });
      const child = runTaskInFlow({
        childSessionKey: "agent:codex:acp:child",
        flowId: flow.flowId,
        lastEventAt: 10,
        runId: "run-flow-sticky-cancel",
        runtime: "acp",
        startedAt: 10,
        status: "running",
        task: "Inspect a PR",
      }).task!;

      const cancelled = await cancelFlowById({
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        cancelled: false,
        flow: expect.objectContaining({
          cancelRequestedAt: expect.any(Number),
          flowId: flow.flowId,
          status: "queued",
        }),
        found: true,
        reason: "One or more child tasks are still active.",
      });

      failTaskRunByRunId({
        endedAt: 50,
        error: "cancel completed later",
        lastEventAt: 50,
        runId: "run-flow-sticky-cancel",
        status: "cancelled",
      });

      expect(getTaskById(child.taskId)).toMatchObject({
        status: "cancelled",
        taskId: child.taskId,
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        cancelRequestedAt: expect.any(Number),
        endedAt: 50,
        flowId: flow.flowId,
        status: "cancelled",
      });
    });
  });

  it("denies cross-owner flow cancellation through the owner-scoped wrapper", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
        ownerKey: "agent:main:main",
      });

      const cancelled = await cancelFlowByIdForOwner({
        callerOwnerKey: "agent:main:other",
        cfg: {} as never,
        flowId: flow.flowId,
      });

      expect(cancelled).toMatchObject({
        cancelled: false,
        found: false,
        reason: "Flow not found.",
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "queued",
      });
    });
  });

  it("denies cross-owner managed TaskFlow child spawning through the owner-scoped wrapper", async () => {
    await withTaskExecutorStateDir(async () => {
      const flow = createManagedTaskFlow({
        controllerId: "tests/managed-flow",
        goal: "Protected flow",
        ownerKey: "agent:main:main",
      });

      const created = runTaskInFlowForOwner({
        callerOwnerKey: "agent:main:other",
        childSessionKey: "agent:codex:acp:child",
        flowId: flow.flowId,
        runId: "run-flow-cross-owner",
        runtime: "acp",
        task: "Should be denied",
      });

      expect(created).toMatchObject({
        created: false,
        found: false,
        reason: "Flow not found.",
      });
      expect(findLatestTaskForFlowId(flow.flowId)).toBeUndefined();
    });
  });

  it("cancels active ACP child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.cancelSessionMock.mockResolvedValue(undefined);

      const child = createRunningTaskRun({
        childSessionKey: "agent:codex:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-linear-cancel",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 10,
        task: "Inspect a PR",
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelled).toMatchObject({
        cancelled: true,
        found: true,
      });
      expect(getTaskById(child.taskId)).toMatchObject({
        status: "cancelled",
        taskId: child.taskId,
      });
      expect(hoisted.cancelSessionMock).toHaveBeenCalledWith({
        cfg: {} as never,
        reason: "task-cancel",
        sessionKey: "agent:codex:acp:child",
      });
    });
  });

  it("cancels active subagent child tasks", async () => {
    await withTaskExecutorStateDir(async () => {
      hoisted.killSubagentRunAdminMock.mockResolvedValue({
        found: true,
        killed: true,
      });

      const child = createRunningTaskRun({
        childSessionKey: "agent:codex:subagent:child",
        deliveryStatus: "pending",
        ownerKey: "agent:main:main",
        runId: "run-subagent-cancel",
        runtime: "subagent",
        scopeKind: "session",
        startedAt: 10,
        task: "Inspect a PR",
      });

      const cancelled = await cancelDetachedTaskRunById({
        cfg: {} as never,
        taskId: child.taskId,
      });

      expect(cancelled).toMatchObject({
        cancelled: true,
        found: true,
      });
      expect(getTaskById(child.taskId)).toMatchObject({
        status: "cancelled",
        taskId: child.taskId,
      });
      expect(hoisted.killSubagentRunAdminMock).toHaveBeenCalledWith({
        cfg: {} as never,
        sessionKey: "agent:codex:subagent:child",
      });
    });
  });

  it("scopes run-id updates to the matching runtime and session", async () => {
    await withTaskExecutorStateDir(async () => {
      const victim = createRunningTaskRun({
        childSessionKey: "agent:victim:acp:child",
        deliveryStatus: "pending",
        ownerKey: "agent:victim:main",
        runId: "run-shared-executor-scope",
        runtime: "acp",
        scopeKind: "session",
        task: "Victim ACP task",
      });
      const attacker = createRunningTaskRun({
        childSessionKey: "agent:attacker:main",
        deliveryStatus: "not_applicable",
        ownerKey: "agent:attacker:main",
        runId: "run-shared-executor-scope",
        runtime: "cli",
        scopeKind: "session",
        task: "Attacker CLI task",
      });

      failTaskRunByRunId({
        endedAt: 40,
        error: "attacker controlled error",
        lastEventAt: 40,
        runId: "run-shared-executor-scope",
        runtime: "cli",
        sessionKey: "agent:attacker:main",
      });

      expect(getTaskById(attacker.taskId)).toMatchObject({
        error: "attacker controlled error",
        status: "failed",
      });
      expect(getTaskById(victim.taskId)).toMatchObject({
        status: "running",
      });
    });
  });
});
