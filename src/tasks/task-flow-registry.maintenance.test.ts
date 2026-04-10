import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { createRunningTaskRun } from "./task-executor.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import {
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "./task-flow-registry.maintenance.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withTaskFlowMaintenanceStateDir(
  run: (root: string) => Promise<void>,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-task-flow-maintenance-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    try {
      await run(root);
    } finally {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
    }
  });
}

describe("task-flow-registry maintenance", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("finalizes cancel-requested managed flows once no child tasks remain active", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        cancelRequestedAt: 100,
        controllerId: "tests/task-flow-maintenance",
        createdAt: 1,
        goal: "Cancel work",
        ownerKey: "agent:main:main",
        status: "running",
        updatedAt: 100,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        pruned: 0,
        reconciled: 1,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        pruned: 0,
        reconciled: 1,
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        cancelRequestedAt: 100,
        flowId: flow.flowId,
        status: "cancelled",
      });
    });
  });

  it("prunes old terminal flows", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();
      const oldFlow = createManagedTaskFlow({
        controllerId: "tests/task-flow-maintenance",
        createdAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
        goal: "Old terminal flow",
        ownerKey: "agent:main:main",
        status: "succeeded",
        updatedAt: now - 8 * 24 * 60 * 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        pruned: 1,
        reconciled: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        pruned: 1,
        reconciled: 0,
      });
      expect(getTaskFlowById(oldFlow.flowId)).toBeUndefined();
    });
  });

  it("does not finalize cancel-requested flows while a child task is still active", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        controllerId: "tests/task-flow-maintenance",
        createdAt: 1,
        goal: "Wait for child cancel",
        ownerKey: "agent:main:main",
        status: "running",
        updatedAt: 100,
      });

      const child = createRunningTaskRun({
        childSessionKey: "agent:main:child",
        lastEventAt: 100,
        ownerKey: "agent:main:main",
        parentFlowId: flow.flowId,
        runId: "run-active-child",
        runtime: "acp",
        scopeKind: "session",
        startedAt: 100,
        task: "Inspect repo",
      });

      expect(
        requestFlowCancel({
          cancelRequestedAt: 100,
          expectedRevision: flow.revision,
          flowId: flow.flowId,
          updatedAt: 100,
        }),
      ).toMatchObject({
        applied: true,
        flow: expect.objectContaining({
          cancelRequestedAt: 100,
          flowId: flow.flowId,
        }),
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        pruned: 0,
        reconciled: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        pruned: 0,
        reconciled: 0,
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        cancelRequestedAt: 100,
        flowId: flow.flowId,
        status: "running",
      });
      expect(child.parentFlowId).toBe(flow.flowId);
    });
  });

  it("prunes many old terminal flows while keeping fresh and active ones", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();

      for (let index = 0; index < 25; index += 1) {
        createManagedTaskFlow({
          controllerId: "tests/task-flow-maintenance",
          createdAt: now - 8 * 24 * 60 * 60_000 - index,
          endedAt: now - 8 * 24 * 60 * 60_000 - index,
          goal: `Old terminal flow ${index}`,
          ownerKey: `agent:main:${index}`,
          status: "succeeded",
          updatedAt: now - 8 * 24 * 60 * 60_000 - index,
        });
      }

      const fresh = createManagedTaskFlow({
        controllerId: "tests/task-flow-maintenance",
        createdAt: now - 2 * 24 * 60 * 60_000,
        endedAt: now - 2 * 24 * 60 * 60_000,
        goal: "Fresh terminal flow",
        ownerKey: "agent:main:fresh",
        status: "succeeded",
        updatedAt: now - 2 * 24 * 60 * 60_000,
      });

      const running = createManagedTaskFlow({
        controllerId: "tests/task-flow-maintenance",
        createdAt: now - 60_000,
        goal: "Active flow",
        ownerKey: "agent:main:running",
        status: "running",
        updatedAt: now - 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        pruned: 25,
        reconciled: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        pruned: 25,
        reconciled: 0,
      });

      const remainingFlowIds = new Set(listTaskFlowRecords().map((flow) => flow.flowId));
      expect(remainingFlowIds).toEqual(new Set([fresh.flowId, running.flowId]));
    });
  });
});
