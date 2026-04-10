import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  findTaskByRunId,
  markTaskLostById,
  maybeDeliverTaskStateChangeUpdate,
  resetTaskRegistryForTests,
} from "./task-registry.js";
import { resolveTaskRegistryDir, resolveTaskRegistrySqlitePath } from "./task-registry.paths.js";
import {
  type TaskRegistryObserverEvent,
  configureTaskRegistryRuntime,
} from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

function createStoredTask(): TaskRecord {
  return {
    childSessionKey: "agent:codex:acp:restored",
    createdAt: 100,
    deliveryStatus: "pending",
    lastEventAt: 100,
    notifyPolicy: "done_only",
    ownerKey: "agent:main:main",
    requesterSessionKey: "agent:main:main",
    runId: "run-restored",
    runtime: "acp",
    scopeKind: "session",
    sourceId: "run-restored",
    status: "running",
    task: "Restored task",
    taskId: "task-restored",
  };
}

describe("task-registry store runtime", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("uses the configured task store for restore and save", () => {
    const storedTask = createStoredTask();
    const loadSnapshot = vi.fn(() => ({
      deliveryStates: new Map(),
      tasks: new Map([[storedTask.taskId, storedTask]]),
    }));
    const saveSnapshot = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    expect(findTaskByRunId("run-restored")).toMatchObject({
      task: "Restored task",
      taskId: "task-restored",
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createTaskRecord({
      childSessionKey: "agent:codex:acp:new",
      deliveryStatus: "pending",
      ownerKey: "agent:main:main",
      runId: "run-new",
      runtime: "acp",
      scopeKind: "session",
      status: "running",
      task: "New task",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls.at(-1)?.[0] as {
      tasks: ReadonlyMap<string, TaskRecord>;
    };
    expect(latestSnapshot.tasks.size).toBe(2);
    expect(latestSnapshot.tasks.get("task-restored")?.task).toBe("Restored task");
  });

  it("emits incremental observer events for restore, mutation, and delete", () => {
    const events: TaskRegistryObserverEvent[] = [];
    configureTaskRegistryRuntime({
      observers: {
        onEvent: (event) => {
          events.push(event);
        },
      },
      store: {
        loadSnapshot: () => ({
          deliveryStates: new Map(),
          tasks: new Map([[createStoredTask().taskId, createStoredTask()]]),
        }),
        saveSnapshot: () => {},
      },
    });

    expect(findTaskByRunId("run-restored")).toBeTruthy();
    const created = createTaskRecord({
      childSessionKey: "agent:codex:acp:new",
      deliveryStatus: "pending",
      ownerKey: "agent:main:main",
      runId: "run-new",
      runtime: "acp",
      scopeKind: "session",
      status: "running",
      task: "New task",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(events.map((event) => event.kind)).toEqual(["restored", "upserted", "deleted"]);
    expect(events[0]).toMatchObject({
      kind: "restored",
      tasks: [expect.objectContaining({ taskId: "task-restored" })],
    });
    expect(events[1]).toMatchObject({
      kind: "upserted",
      task: expect.objectContaining({ taskId: created.taskId }),
    });
    expect(events[2]).toMatchObject({
      kind: "deleted",
      taskId: created.taskId,
    });
  });

  it("uses atomic task-plus-delivery store methods when available", async () => {
    const upsertTaskWithDeliveryState = vi.fn();
    const deleteTaskWithDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        deleteTaskWithDeliveryState,
        loadSnapshot: () => ({
          deliveryStates: new Map(),
          tasks: new Map(),
        }),
        saveSnapshot: vi.fn(),
        upsertTaskWithDeliveryState,
      },
    });

    const created = createTaskRecord({
      childSessionKey: "agent:codex:acp:new",
      deliveryStatus: "pending",
      notifyPolicy: "state_changes",
      ownerKey: "agent:main:main",
      runId: "run-atomic",
      runtime: "acp",
      scopeKind: "session",
      status: "running",
      task: "Atomic task",
    });

    await maybeDeliverTaskStateChangeUpdate(created.taskId, {
      at: 200,
      kind: "progress",
      summary: "working",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(upsertTaskWithDeliveryState).toHaveBeenCalled();
    expect(upsertTaskWithDeliveryState.mock.calls[0]?.[0]).toMatchObject({
      task: expect.objectContaining({
        taskId: created.taskId,
      }),
    });
    expect(
      upsertTaskWithDeliveryState.mock.calls.some((call) => {
        const params = call[0] as { deliveryState?: { lastNotifiedEventAt?: number } };
        return params.deliveryState?.lastNotifiedEventAt === 200;
      }),
    ).toBe(true);
    expect(deleteTaskWithDeliveryState).toHaveBeenCalledWith(created.taskId);
  });

  it("restores persisted tasks from the default sqlite store", () => {
    const created = createTaskRecord({
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      ownerKey: "agent:main:main",
      runId: "run-sqlite",
      runtime: "cron",
      scopeKind: "session",
      sourceId: "job-123",
      status: "running",
      task: "Run nightly cron",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-sqlite")).toMatchObject({
      sourceId: "job-123",
      task: "Run nightly cron",
      taskId: created.taskId,
    });
  });

  it("persists parentFlowId with task rows", () => {
    const flow = createManagedTaskFlow({
      controllerId: "tests/task-store-parent-flow",
      goal: "Persist linked tasks",
      ownerKey: "agent:main:main",
    });
    const created = createTaskRecord({
      childSessionKey: "agent:codex:acp:new",
      deliveryStatus: "pending",
      ownerKey: "agent:main:main",
      parentFlowId: flow.flowId,
      runId: "run-flow-linked",
      runtime: "acp",
      scopeKind: "session",
      status: "running",
      task: "Linked task",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-flow-linked")).toMatchObject({
      parentFlowId: flow.flowId,
      taskId: created.taskId,
    });
  });

  it("hardens the sqlite task store directory and file modes", () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-task-store-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    createTaskRecord({
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      ownerKey: "agent:main:main",
      runId: "run-perms",
      runtime: "cron",
      scopeKind: "session",
      sourceId: "job-456",
      status: "running",
      task: "Run secured cron",
    });

    const registryDir = resolveTaskRegistryDir(process.env);
    const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
    expect(statSync(registryDir).mode & 0o777).toBe(0o700);
    expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);

    resetTaskRegistryForTests();
    rmSync(stateDir, { force: true, recursive: true });
  });

  it("migrates legacy ownerless cron rows to system scope", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-task-store-legacy-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
    `);
    db.exec(`
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO task_runs (
        task_id,
        runtime,
        source_id,
        requester_session_key,
        child_session_key,
        run_id,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-cron-task",
      "cron",
      "nightly-digest",
      "",
      "agent:main:cron:nightly-digest",
      "legacy-cron-run",
      "Nightly digest",
      "running",
      "not_applicable",
      "silent",
      100,
      100,
    );
    db.close();

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("legacy-cron-run")).toMatchObject({
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      ownerKey: "system:cron:nightly-digest",
      scopeKind: "system",
      taskId: "legacy-cron-task",
    });
  });

  it("keeps legacy requester_session_key rows writable after restore", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-task-store-legacy-write-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
    `);
    db.exec(`
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO task_runs (
        task_id,
        runtime,
        requester_session_key,
        run_id,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-session-task",
      "acp",
      "agent:main:main",
      "legacy-session-run",
      "Legacy session task",
      "running",
      "pending",
      "done_only",
      100,
      100,
    );
    db.close();

    resetTaskRegistryForTests({ persist: false });

    expect(() =>
      markTaskLostById({
        endedAt: 200,
        error: "session missing",
        lastEventAt: 200,
        taskId: "legacy-session-task",
      }),
    ).not.toThrow();
    expect(findTaskByRunId("legacy-session-run")).toMatchObject({
      error: "session missing",
      status: "lost",
      taskId: "legacy-session-task",
    });
  });
});
