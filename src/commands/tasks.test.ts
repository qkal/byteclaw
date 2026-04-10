import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createRunningTaskRun } from "../tasks/task-executor.js";
import {
  createManagedTaskFlow,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { tasksAuditCommand, tasksMaintenanceCommand } from "./tasks.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  } as unknown as RuntimeEnv;
}

async function withTaskCommandStateDir(run: () => Promise<void>): Promise<void> {
  await withTempDir({ prefix: "openclaw-tasks-command-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      await run();
    } finally {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

describe("tasks commands", () => {
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
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("keeps tasks audit JSON stable while adding TaskFlow summary fields", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createRunningTaskRun({
        ownerKey: "agent:main:main",
        runId: "task-stale-queued",
        runtime: "cli",
        scopeKind: "session",
        task: "Inspect issue backlog",
      });
      vi.setSystemTime(now);
      createManagedTaskFlow({
        controllerId: "tests/tasks-command",
        createdAt: now - 40 * 60_000,
        goal: "Inspect issue backlog",
        ownerKey: "agent:main:main",
        status: "waiting",
        updatedAt: now - 40 * 60_000,
      });

      const runtime = createRuntime();
      await tasksAuditCommand({ json: true }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        summary: {
          total: number;
          errors: number;
          warnings: number;
          byCode: Record<string, number>;
          taskFlows: { total: number; byCode: Record<string, number> };
          combined: { total: number; errors: number; warnings: number };
        };
      };

      expect(payload.summary.byCode.stale_running).toBe(1);
      expect(payload.summary.taskFlows.byCode.stale_waiting).toBe(1);
      expect(payload.summary.taskFlows.byCode.missing_linked_tasks).toBe(1);
      expect(payload.summary.combined.total).toBe(3);
    });
  });

  it("sorts combined audit findings before applying the limit", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - 40 * 60_000);
      createRunningTaskRun({
        ownerKey: "agent:main:main",
        runId: "task-stale-queued",
        runtime: "cli",
        scopeKind: "session",
        task: "Queue audit",
      });
      vi.setSystemTime(now);
      const runningFlow = createManagedTaskFlow({
        controllerId: "tests/tasks-command",
        createdAt: now - 45 * 60_000,
        goal: "Running flow",
        ownerKey: "agent:main:main",
        status: "running",
        updatedAt: now - 45 * 60_000,
      });

      const runtime = createRuntime();
      await tasksAuditCommand({ json: true, limit: 1 }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        findings: { kind: string; code: string; token?: string }[];
      };

      expect(payload.findings).toHaveLength(1);
      expect(payload.findings[0]).toMatchObject({
        code: "stale_running",
        kind: "task_flow",
        token: runningFlow.flowId,
      });
    });
  });

  it("keeps tasks maintenance JSON additive for TaskFlow state", async () => {
    await withTaskCommandStateDir(async () => {
      const now = Date.now();
      createManagedTaskFlow({
        controllerId: "tests/tasks-command",
        createdAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
        goal: "Old terminal flow",
        ownerKey: "agent:main:main",
        status: "succeeded",
        updatedAt: now - 8 * 24 * 60 * 60_000,
      });

      const runtime = createRuntime();
      await tasksMaintenanceCommand({ apply: false, json: true }, runtime);

      const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        mode: string;
        maintenance: { taskFlows: { pruned: number } };
        auditBefore: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
        };
        auditAfter: {
          byCode: Record<string, number>;
          taskFlows: { byCode: Record<string, number> };
        };
      };

      expect(payload.mode).toBe("preview");
      expect(payload.maintenance.taskFlows.pruned).toBe(1);
      expect(payload.auditBefore.byCode).toBeDefined();
      expect(payload.auditBefore.taskFlows.byCode.stale_running).toBe(0);
      expect(payload.auditAfter.byCode).toBeDefined();
      expect(payload.auditAfter.taskFlows.byCode.stale_running).toBe(0);
    });
  });
});
