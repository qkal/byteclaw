import { statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  setFlowWaiting,
} from "./task-flow-registry.js";
import {
  resolveTaskFlowRegistryDir,
  resolveTaskFlowRegistrySqlitePath,
} from "./task-flow-registry.paths.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

function createStoredFlow(): TaskFlowRecord {
  return {
    blockedSummary: "Writable session required.",
    blockedTaskId: "task-restored",
    cancelRequestedAt: 115,
    controllerId: "tests/restored-controller",
    createdAt: 100,
    currentStep: "spawn_task",
    endedAt: 120,
    flowId: "flow-restored",
    goal: "Restored flow",
    notifyPolicy: "done_only",
    ownerKey: "agent:main:main",
    revision: 4,
    stateJson: { done: 3, lane: "triage" },
    status: "blocked",
    syncMode: "managed",
    updatedAt: 120,
    waitJson: { kind: "task", taskId: "task-restored" },
  };
}

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-task-flow-store-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskFlowRegistryForTests();
    try {
      return await run(root);
    } finally {
      resetTaskFlowRegistryForTests();
    }
  });
}

describe("task-flow-registry store runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OPENCLAW_STATE_DIR;
    resetTaskFlowRegistryForTests();
  });

  it("uses the configured flow store for restore and save", () => {
    const storedFlow = createStoredFlow();
    const loadSnapshot = vi.fn(() => ({
      flows: new Map([[storedFlow.flowId, storedFlow]]),
    }));
    const saveSnapshot = vi.fn();
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    expect(getTaskFlowById("flow-restored")).toMatchObject({
      cancelRequestedAt: 115,
      controllerId: "tests/restored-controller",
      flowId: "flow-restored",
      revision: 4,
      stateJson: { done: 3, lane: "triage" },
      syncMode: "managed",
      waitJson: { kind: "task", taskId: "task-restored" },
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createManagedTaskFlow({
      controllerId: "tests/new-flow",
      currentStep: "wait_for",
      goal: "New flow",
      ownerKey: "agent:main:main",
      status: "running",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls.at(-1)?.[0] as {
      flows: ReadonlyMap<string, TaskFlowRecord>;
    };
    expect(latestSnapshot.flows.size).toBe(2);
    expect(latestSnapshot.flows.get("flow-restored")?.goal).toBe("Restored flow");
  });

  it("restores persisted wait-state, revision, and cancel intent from sqlite", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        controllerId: "tests/persisted-flow",
        currentStep: "spawn_task",
        goal: "Persisted flow",
        ownerKey: "agent:main:main",
        stateJson: { phase: "spawn" },
        status: "running",
      });
      const waiting = setFlowWaiting({
        currentStep: "ask_user",
        expectedRevision: created.revision,
        flowId: created.flowId,
        stateJson: { phase: "ask_user" },
        waitJson: { kind: "external_event", topic: "telegram" },
      });
      expect(waiting).toMatchObject({
        applied: true,
      });
      const cancelRequested = requestFlowCancel({
        cancelRequestedAt: 444,
        expectedRevision: waiting.applied ? waiting.flow.revision : -1,
        flowId: created.flowId,
      });
      expect(cancelRequested).toMatchObject({
        applied: true,
      });

      resetTaskFlowRegistryForTests({ persist: false });

      expect(getTaskFlowById(created.flowId)).toMatchObject({
        cancelRequestedAt: 444,
        controllerId: "tests/persisted-flow",
        currentStep: "ask_user",
        flowId: created.flowId,
        revision: 2,
        stateJson: { phase: "ask_user" },
        status: "waiting",
        syncMode: "managed",
        waitJson: { kind: "external_event", topic: "telegram" },
      });
    });
  });

  it("round-trips explicit json null through sqlite", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        controllerId: "tests/null-roundtrip",
        goal: "Persist null payloads",
        ownerKey: "agent:main:main",
        stateJson: null,
        waitJson: null,
      });

      resetTaskFlowRegistryForTests({ persist: false });

      expect(getTaskFlowById(created.flowId)).toMatchObject({
        flowId: created.flowId,
        stateJson: null,
        waitJson: null,
      });
    });
  });

  it("hardens the sqlite flow store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      createManagedTaskFlow({
        blockedSummary: "Need auth.",
        blockedTaskId: "task-secured",
        controllerId: "tests/secured-flow",
        goal: "Secured flow",
        ownerKey: "agent:main:main",
        status: "blocked",
        waitJson: { kind: "task", taskId: "task-secured" },
      });

      const registryDir = resolveTaskFlowRegistryDir(process.env);
      const sqlitePath = resolveTaskFlowRegistrySqlitePath(process.env);
      expect(statSync(registryDir).mode & 0o777).toBe(0o700);
      expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);
    });
  });
});
