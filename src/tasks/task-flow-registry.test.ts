import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createFlowRecord,
  createManagedTaskFlow,
  createTaskFlowForTask,
  deleteTaskFlowRecordById,
  failFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  resumeFlow,
  setFlowWaiting,
  syncFlowFromTask,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-task-flow-registry-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskFlowRegistryForTests();
    try {
      return await run(root);
    } finally {
      resetTaskFlowRegistryForTests();
    }
  });
}

describe("task-flow-registry", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskFlowRegistryForTests();
  });

  it("creates managed flows and updates them through revision-checked helpers", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        controllerId: "tests/managed-controller",
        currentStep: "spawn_task",
        goal: "Investigate flaky test",
        ownerKey: "agent:main:main",
        stateJson: { phase: "spawn" },
      });

      expect(created).toMatchObject({
        controllerId: "tests/managed-controller",
        currentStep: "spawn_task",
        flowId: created.flowId,
        revision: 0,
        stateJson: { phase: "spawn" },
        status: "queued",
        syncMode: "managed",
      });

      const waiting = setFlowWaiting({
        currentStep: "await_review",
        expectedRevision: created.revision,
        flowId: created.flowId,
        stateJson: { phase: "await_review" },
        waitJson: { kind: "task", taskId: "task-123" },
      });
      expect(waiting).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          currentStep: "await_review",
          flowId: created.flowId,
          revision: 1,
          status: "waiting",
          waitJson: { kind: "task", taskId: "task-123" },
        }),
      });

      const conflict = updateFlowRecordByIdExpectedRevision({
        expectedRevision: 0,
        flowId: created.flowId,
        patch: {
          currentStep: "stale",
        },
      });
      expect(conflict).toMatchObject({
        applied: false,
        current: expect.objectContaining({
          flowId: created.flowId,
          revision: 1,
        }),
        reason: "revision_conflict",
      });

      const resumed = resumeFlow({
        currentStep: "resume_work",
        expectedRevision: 1,
        flowId: created.flowId,
        status: "running",
      });
      expect(resumed).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          currentStep: "resume_work",
          flowId: created.flowId,
          revision: 2,
          status: "running",
          waitJson: null,
        }),
      });

      const cancelRequested = requestFlowCancel({
        cancelRequestedAt: 400,
        expectedRevision: 2,
        flowId: created.flowId,
      });
      expect(cancelRequested).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          cancelRequestedAt: 400,
          flowId: created.flowId,
          revision: 3,
        }),
      });

      const failed = failFlow({
        blockedSummary: "Task runner failed.",
        endedAt: 500,
        expectedRevision: 3,
        flowId: created.flowId,
      });
      expect(failed).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          blockedSummary: "Task runner failed.",
          endedAt: 500,
          flowId: created.flowId,
          revision: 4,
          status: "failed",
        }),
      });

      expect(listTaskFlowRecords()).toEqual([
        expect.objectContaining({
          cancelRequestedAt: 400,
          flowId: created.flowId,
          revision: 4,
        }),
      ]);

      expect(deleteTaskFlowRecordById(created.flowId)).toBe(true);
      expect(getTaskFlowById(created.flowId)).toBeUndefined();
    });
  });

  it("requires a controller for managed flows and rejects clearing it later", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      expect(() =>
        createFlowRecord({
          goal: "Missing controller",
          ownerKey: "agent:main:main",
        }),
      ).toThrow("Managed flow controllerId is required.");

      const created = createManagedTaskFlow({
        controllerId: "tests/managed-controller",
        goal: "Protected controller",
        ownerKey: "agent:main:main",
      });

      expect(() =>
        updateFlowRecordByIdExpectedRevision({
          expectedRevision: created.revision,
          flowId: created.flowId,
          patch: {
            controllerId: null,
          },
        }),
      ).toThrow("Managed flow controllerId is required.");
    });
  });

  it("emits restored, upserted, and deleted flow observer events", () => {
    const onEvent = vi.fn();
    configureTaskFlowRegistryRuntime({
      observers: {
        onEvent,
      },
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
      },
    });

    const created = createManagedTaskFlow({
      controllerId: "tests/observers",
      goal: "Observe observers",
      ownerKey: "agent:main:main",
    });

    deleteTaskFlowRecordById(created.flowId);

    expect(onEvent).toHaveBeenCalledWith({
      flows: [],
      kind: "restored",
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: expect.objectContaining({
          flowId: created.flowId,
        }),
        kind: "upserted",
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: created.flowId,
        kind: "deleted",
      }),
    );
  });

  it("normalizes restored managed flows without a controller id", () => {
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map([
            [
              "legacy-managed",
              {
                createdAt: 10,
                flowId: "legacy-managed",
                goal: "Legacy managed flow",
                notifyPolicy: "done_only",
                ownerKey: "agent:main:main",
                revision: 0,
                status: "queued",
                syncMode: "managed",
                updatedAt: 10,
              },
            ],
          ]),
        }),
        saveSnapshot: () => {},
      },
    });

    expect(getTaskFlowById("legacy-managed")).toMatchObject({
      controllerId: "core/legacy-restored",
      flowId: "legacy-managed",
      syncMode: "managed",
    });
  });

  it("mirrors one-task flow state from tasks and leaves managed flows alone", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const mirrored = createTaskFlowForTask({
        task: {
          createdAt: 100,
          label: "Fix permissions",
          lastEventAt: 100,
          notifyPolicy: "done_only",
          ownerKey: "agent:main:main",
          status: "running",
          task: "Fix permissions",
          taskId: "task-running",
        },
      });

      const blocked = syncFlowFromTask({
        endedAt: 200,
        label: "Fix permissions",
        lastEventAt: 200,
        notifyPolicy: "done_only",
        parentFlowId: mirrored.flowId,
        status: "succeeded",
        task: "Fix permissions",
        taskId: "task-blocked",
        terminalOutcome: "blocked",
        terminalSummary: "Writable session required.",
      });
      expect(blocked).toMatchObject({
        blockedSummary: "Writable session required.",
        blockedTaskId: "task-blocked",
        flowId: mirrored.flowId,
        status: "blocked",
        syncMode: "task_mirrored",
      });

      const managed = createManagedTaskFlow({
        controllerId: "tests/managed",
        currentStep: "wait_for",
        goal: "Cluster PRs",
        ownerKey: "agent:main:main",
        status: "waiting",
        waitJson: { kind: "external_event" },
      });
      const syncedManaged = syncFlowFromTask({
        label: "Child task",
        lastEventAt: 250,
        notifyPolicy: "done_only",
        parentFlowId: managed.flowId,
        progressSummary: "Running child task",
        status: "running",
        task: "Child task",
        taskId: "task-child",
      });
      expect(syncedManaged).toMatchObject({
        currentStep: "wait_for",
        flowId: managed.flowId,
        status: "waiting",
        syncMode: "managed",
        waitJson: { kind: "external_event" },
      });
    });
  });

  it("preserves explicit json null in state and wait payloads", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        controllerId: "tests/null-state",
        goal: "Null payloads",
        ownerKey: "agent:main:main",
        stateJson: null,
        waitJson: null,
      });

      expect(created).toMatchObject({
        flowId: created.flowId,
        stateJson: null,
        waitJson: null,
      });

      const resumed = resumeFlow({
        expectedRevision: created.revision,
        flowId: created.flowId,
        stateJson: null,
      });

      expect(resumed).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          flowId: created.flowId,
          stateJson: null,
        }),
      });
    });
  });
});
