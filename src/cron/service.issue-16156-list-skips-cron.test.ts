import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  baseTimeIso: "2025-12-13T00:00:00.000Z",
  prefix: "openclaw-cron-16156-",
});

async function writeJobsStore(storePath: string, jobs: unknown[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ jobs, version: 1 }, null, 2), "utf8");
}

function createCronFromStorePath(storePath: string) {
  return new CronService({
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    log: noopLogger,
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    storePath,
  });
}

describe("#16156: cron.list() must not silently advance past-due recurring jobs", () => {
  it("does not skip a cron job when list() is called while the job is past-due", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      logger: noopLogger,
      storePath: store.storePath,
    });

    await cron.start();

    // Create a cron job that fires every minute.
    const job = await cron.add({
      enabled: true,
      name: "every-minute",
      payload: { kind: "systemEvent", text: "cron-tick" },
      schedule: { expr: "* * * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });

    const firstDueAt = job.state.nextRunAtMs!;
    expect(firstDueAt).toBe(Date.parse("2025-12-13T00:01:00.000Z"));

    // Advance time so the job is past-due but the timer hasn't fired yet.
    vi.setSystemTime(new Date(firstDueAt + 5));

    // Simulate the user running `cron list` while the job is past-due.
    // Before the fix, this would call recomputeNextRuns() which silently
    // Advances nextRunAtMs to the next occurrence (00:02:00) without
    // Executing the job.
    const listedBefore = await cron.list({ includeDisabled: true });
    const jobBeforeTimer = listedBefore.find((j) => j.id === job.id);

    // The job should still show the past-due nextRunAtMs, NOT the advanced one.
    expect(jobBeforeTimer?.state.nextRunAtMs).toBe(firstDueAt);

    // Now let the timer fire. The job should be found as due and execute.
    await vi.runOnlyPendingTimersAsync();

    await finished.waitForOk(job.id);

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);

    // Job must have actually executed.
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "cron-tick",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(updated?.state.lastStatus).toBe("ok");
    // NextRunAtMs must advance to a future minute boundary after execution.
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(firstDueAt);

    cron.stop();
  });

  it("does not skip a cron job when status() is called while the job is past-due", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      logger: noopLogger,
      storePath: store.storePath,
    });

    await cron.start();

    const job = await cron.add({
      enabled: true,
      name: "five-min-cron",
      payload: { kind: "systemEvent", text: "tick-5" },
      schedule: { expr: "*/5 * * * *", kind: "cron" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
    });

    const firstDueAt = job.state.nextRunAtMs!;

    // Advance time past due.
    vi.setSystemTime(new Date(firstDueAt + 10));

    // Call status() while job is past-due.
    await cron.status();

    // Timer fires.
    await vi.runOnlyPendingTimersAsync();

    await finished.waitForOk(job.id);

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "tick-5",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(updated?.state.lastStatus).toBe("ok");

    cron.stop();
  });

  it("still fills missing nextRunAtMs via list() for enabled jobs", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    // Write a store file with a cron job that has no nextRunAtMs.
    await writeJobsStore(store.storePath, [
      {
        createdAtMs: nowMs,
        enabled: true,
        id: "missing-next",
        name: "missing next",
        payload: { kind: "systemEvent", text: "fill-me" },
        schedule: { expr: "* * * * *", kind: "cron", tz: "UTC" },
        sessionTarget: "main",
        state: {},
        updatedAtMs: nowMs,
        wakeMode: "now",
      },
    ]);

    const cron = createCronFromStorePath(store.storePath);

    await cron.start();

    // List() should fill in the missing nextRunAtMs via maintenance recompute.
    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === "missing-next");

    expect(job?.state.nextRunAtMs).toBeTypeOf("number");
    expect(job?.state.nextRunAtMs).toBeGreaterThan(nowMs);

    cron.stop();
  });
});
