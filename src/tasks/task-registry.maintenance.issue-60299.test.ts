import { describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./task-registry.types.js";

const GRACE_EXPIRED_MS = 10 * 60_000;

function makeStaleTask(overrides: Partial<TaskRecord>): TaskRecord {
  const now = Date.now();
  return {
    createdAt: now - GRACE_EXPIRED_MS,
    deliveryStatus: "not_applicable",
    lastEventAt: now - GRACE_EXPIRED_MS,
    notifyPolicy: "silent",
    ownerKey: "system:cron:test",
    requesterSessionKey: "agent:main:main",
    runtime: "cron",
    scopeKind: "system",
    startedAt: now - GRACE_EXPIRED_MS,
    status: "running",
    task: "test task",
    taskId: "task-test-" + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

async function loadMaintenanceModule(params: {
  tasks: TaskRecord[];
  sessionStore?: Record<string, unknown>;
  acpEntry?: unknown;
  activeCronJobIds?: string[];
  activeRunIds?: string[];
}) {
  vi.resetModules();

  const sessionStore = params.sessionStore ?? {};
  const { acpEntry } = params;
  const activeCronJobIds = new Set(params.activeCronJobIds ?? []);
  const activeRunIds = new Set(params.activeRunIds ?? []);
  const currentTasks = new Map(params.tasks.map((task) => [task.taskId, { ...task }]));

  vi.doMock("../acp/runtime/session-meta.js", () => ({
    readAcpSessionEntry: () =>
      acpEntry !== undefined
        ? { entry: acpEntry, storeReadFailed: false }
        : { entry: undefined, storeReadFailed: false },
  }));

  vi.doMock("../config/sessions.js", () => ({
    loadSessionStore: () => sessionStore,
    resolveStorePath: () => "",
  }));

  vi.doMock("../cron/active-jobs.js", () => ({
    isCronJobActive: (jobId: string) => activeCronJobIds.has(jobId),
  }));

  vi.doMock("../infra/agent-events.js", () => ({
    getAgentRunContext: (runId: string) =>
      activeRunIds.has(runId) ? { sessionKey: "main" } : undefined,
  }));

  vi.doMock("./runtime-internal.js", () => ({
    deleteTaskRecordById: (taskId: string) => currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => currentTasks.get(taskId),
    listTaskRecords: () => params.tasks,
    markTaskLostById: (patch: {
      taskId: string;
      endedAt: number;
      lastEventAt?: number;
      error?: string;
      cleanupAfter?: number;
    }) => {
      const current = currentTasks.get(patch.taskId);
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
      currentTasks.set(patch.taskId, next);
      return next;
    },
    maybeDeliverTaskTerminalUpdate: () => false,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: (patch: { taskId: string; cleanupAfter: number }) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = { ...current, cleanupAfter: patch.cleanupAfter };
      currentTasks.set(patch.taskId, next);
      return next;
    },
  }));

  const mod = await import("./task-registry.maintenance.js");
  return { currentTasks, mod };
}

describe("task-registry maintenance issue #60299", () => {
  it("marks stale cron tasks lost once the runtime no longer tracks the job as active", async () => {
    const childSessionKey = "agent:main:slack:channel:test-channel";
    const task = makeStaleTask({
      childSessionKey,
      runtime: "cron",
      sourceId: "cron-job-1",
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      sessionStore: { [childSessionKey]: { updatedAt: Date.now() } },
      tasks: [task],
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("keeps active cron tasks live while the cron runtime still owns the job", async () => {
    const task = makeStaleTask({
      childSessionKey: undefined,
      runtime: "cron",
      sourceId: "cron-job-2",
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      activeCronJobIds: ["cron-job-2"],
      tasks: [task],
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });

  it("marks chat-backed cli tasks lost after the owning run context disappears", async () => {
    const channelKey = "agent:main:slack:channel:C1234567890";
    const task = makeStaleTask({
      childSessionKey: channelKey,
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      runId: "run-chat-cli-stale",
      runtime: "cli",
      sourceId: "run-chat-cli-stale",
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      sessionStore: { [channelKey]: { updatedAt: Date.now() } },
      tasks: [task],
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "lost" });
  });

  it("keeps chat-backed cli tasks live while the owning run context is still active", async () => {
    const channelKey = "agent:main:slack:channel:C1234567890";
    const task = makeStaleTask({
      childSessionKey: channelKey,
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      runId: "run-chat-cli-live",
      runtime: "cli",
      sourceId: "run-chat-cli-live",
    });

    const { mod, currentTasks } = await loadMaintenanceModule({
      activeRunIds: ["run-chat-cli-live"],
      sessionStore: { [channelKey]: { updatedAt: Date.now() } },
      tasks: [task],
    });

    expect(await mod.runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({ status: "running" });
  });
});
