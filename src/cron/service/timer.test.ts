import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.js";
import type { CronJob } from "../../cron/types.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-seam",
});

function createDueMainJob(params: { now: number; wakeMode: CronJob["wakeMode"] }): CronJob {
  return {
    createdAtMs: params.now - 60_000,
    enabled: true,
    id: "main-heartbeat-job",
    name: "main heartbeat job",
    payload: { kind: "systemEvent", text: "heartbeat seam tick" },
    schedule: { anchorMs: params.now - 60_000, everyMs: 60_000, kind: "every" },
    sessionKey: "agent:main:main",
    sessionTarget: "main",
    state: { nextRunAtMs: params.now - 1 },
    updatedAtMs: params.now - 60_000,
    wakeMode: params.wakeMode,
  };
}

afterEach(() => {
  resetTaskRegistryForTests();
});

describe("cron service timer seam coverage", () => {
  it("persists the next schedule and hands off next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
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

    await onTimer(state);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      contextKey: "cron:main-heartbeat-job",
      sessionKey: "agent:main:main",
    });
    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      agentId: undefined,
      reason: "cron:main-heartbeat-job",
      sessionKey: "agent:main:main",
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.nextRunAtMs).toBe(now + 60_000);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays.some((delay) => delay > 0)).toBe(true);

    timeoutSpy.mockRestore();
  });

  it("keeps scheduler progress when task ledger creation fails", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      jobs: [createDueMainJob({ now, wakeMode: "next-heartbeat" })],
      storePath,
    });

    const createTaskRecordSpy = vi
      .spyOn(taskExecutor, "createRunningTaskRun")
      .mockImplementation(() => {
        throw new Error("disk full");
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

    await onTimer(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "main-heartbeat-job" }),
      "cron: failed to create task ledger record",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: undefined,
      contextKey: "cron:main-heartbeat-job",
      sessionKey: "agent:main:main",
    });

    createTaskRecordSpy.mockRestore();
  });
});
