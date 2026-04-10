import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { run, start, stop, update } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});

function createInterruptedMainJob(now: number): CronJob {
  return {
    createdAtMs: now - 86_400_000,
    enabled: true,
    id: "startup-interrupted",
    name: "startup interrupted",
    payload: { kind: "systemEvent", text: "should not replay on startup" },
    schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
    sessionTarget: "main",
    state: {
      nextRunAtMs: now - 60_000,
      runningAtMs: now - 30 * 60_000,
    },
    updatedAtMs: now - 30 * 60_000,
    wakeMode: "next-heartbeat",
  };
}

function createDueIsolatedJob(now: number): CronJob {
  return {
    createdAtMs: now - 60_000,
    enabled: true,
    id: "isolated-timeout",
    name: "isolated timeout",
    payload: { kind: "agentTurn", message: "do work" },
    schedule: { anchorMs: now - 60_000, everyMs: 60_000, kind: "every" },
    sessionKey: "agent:main:main",
    sessionTarget: "isolated",
    state: { nextRunAtMs: now - 1 },
    updatedAtMs: now - 60_000,
    wakeMode: "next-heartbeat",
  };
}

function createMissedIsolatedJob(now: number): CronJob {
  return {
    createdAtMs: now - 86_400_000,
    enabled: true,
    id: "startup-timeout",
    name: "startup timeout",
    payload: { kind: "agentTurn", message: "should timeout" },
    schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
    sessionKey: "agent:main:main",
    sessionTarget: "isolated",
    state: {
      nextRunAtMs: now - 60_000,
    },
    updatedAtMs: now - 30 * 60_000,
    wakeMode: "next-heartbeat",
  };
}

describe("cron service ops seam coverage", () => {
  it("start clears stale running markers, replays interrupted recurring jobs, persists, and arms the timer (#60495)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      jobs: [createInterruptedMainJob(now)],
      storePath,
    });

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent,
      log: logger,
      nowMs: () => now,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      storePath,
    });

    await start(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "startup-interrupted" }),
      "cron: clearing stale running marker on startup",
    );
    // Interrupted recurring jobs are now replayed on first restart (#60495)
    expect(enqueueSystemEvent).toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalled();
    expect(state.timer).not.toBeNull();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.lastStatus).toBe("ok");
    expect((job?.state.nextRunAtMs ?? 0) > now).toBe(true);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays.some((delay) => delay > 0)).toBe(true);

    timeoutSpy.mockRestore();
    stop(state);
  });

  it("records timed out manual runs as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const stateRoot = path.dirname(path.dirname(storePath));
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    resetTaskRegistryForTests();

    await writeCronStoreSnapshot({
      jobs: [createDueIsolatedJob(now)],
      storePath,
    });

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: logger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        throw new Error("cron: job execution timed out");
      }),
      storePath,
    });

    await run(state, "isolated-timeout");

    expect(findTaskByRunId(`cron:isolated-timeout:${now}`)).toMatchObject({
      runtime: "cron",
      sourceId: "isolated-timeout",
      status: "timed_out",
    });

    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
  });

  it("keeps manual cron runs progressing when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");

    await writeCronStoreSnapshot({
      jobs: [createDueIsolatedJob(now)],
      storePath,
    });

    const createTaskRecordSpy = vi
      .spyOn(taskExecutor, "createRunningTaskRun")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: logger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
      storePath,
    });

    await expect(run(state, "isolated-timeout")).resolves.toEqual({ ok: true, ran: true });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
    expect(persisted.jobs[0]?.state.lastStatus).toBe("ok");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "isolated-timeout" }),
      "cron: failed to create task ledger record",
    );

    createTaskRecordSpy.mockRestore();
  });

  it("keeps manual cron cleanup progressing when task ledger updates fail", async () => {
    const { storePath } = await makeStorePath();
    const stateRoot = path.dirname(path.dirname(storePath));
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    resetTaskRegistryForTests();

    await writeCronStoreSnapshot({
      jobs: [createDueIsolatedJob(now)],
      storePath,
    });

    const updateTaskRecordSpy = vi
      .spyOn(taskExecutor, "completeTaskRunByRunId")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: logger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
      storePath,
    });

    await expect(run(state, "isolated-timeout")).resolves.toEqual({ ok: true, ran: true });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    expect(persisted.jobs[0]?.state.runningAtMs).toBeUndefined();
    expect(persisted.jobs[0]?.state.lastStatus).toBe("ok");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobStatus: "ok" }),
      "cron: failed to update task ledger record",
    );

    updateTaskRecordSpy.mockRestore();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
  });

  it("non-schedule edit preserves nextRunAtMs (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");
    const originalNextRunAtMs = Date.parse("2026-04-10T09:00:00.000Z");

    await writeCronStoreSnapshot({
      jobs: [
        {
          createdAtMs: now - 86_400_000,
          enabled: true,
          id: "daily-report",
          name: "daily report",
          payload: { kind: "systemEvent", text: "daily" },
          schedule: { expr: "0 9 * * *", kind: "cron", tz: "Asia/Shanghai" },
          sessionTarget: "main",
          state: { nextRunAtMs: originalNextRunAtMs },
          updatedAtMs: now - 3_600_000,
          wakeMode: "next-heartbeat",
        },
      ],
      storePath,
    });

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: logger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      storePath,
    });

    const updated = await update(state, "daily-report", { description: "edited" });

    expect(updated.description).toBe("edited");
    expect(updated.state.nextRunAtMs).toBe(originalNextRunAtMs);
  });

  it("repairs nextRunAtMs=0 on non-schedule edit (#63499)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-04-09T08:00:00.000Z");

    await writeCronStoreSnapshot({
      jobs: [
        {
          createdAtMs: now - 86_400_000,
          enabled: true,
          id: "broken-job",
          name: "broken",
          payload: { kind: "systemEvent", text: "test" },
          schedule: { expr: "0 9 * * *", kind: "cron", tz: "UTC" },
          sessionTarget: "main",
          state: { nextRunAtMs: 0 },
          updatedAtMs: now - 3_600_000,
          wakeMode: "next-heartbeat",
        },
      ],
      storePath,
    });

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: logger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      storePath,
    });

    const updated = await update(state, "broken-job", { description: "fixed" });

    expect(updated.description).toBe("fixed");
    expect(updated.state.nextRunAtMs).toBeGreaterThan(0);
    expect(updated.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("records startup catch-up timeouts as timed_out in the shared task registry", async () => {
    const { storePath } = await makeStorePath();
    const stateRoot = path.dirname(path.dirname(storePath));
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    resetTaskRegistryForTests();

    await writeCronStoreSnapshot({
      jobs: [createMissedIsolatedJob(now)],
      storePath,
    });

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: logger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        throw new Error("cron: job execution timed out");
      }),
      storePath,
    });

    await start(state);

    expect(findTaskByRunId(`cron:startup-timeout:${now}`)).toMatchObject({
      runtime: "cron",
      sourceId: "startup-timeout",
      status: "timed_out",
    });

    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    resetTaskRegistryForTests();
    stop(state);
  });
});
