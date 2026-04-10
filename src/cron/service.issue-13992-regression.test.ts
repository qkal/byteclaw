import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs.js";
import type { CronJob } from "./types.js";

function createCronSystemEventJob(now: number, overrides: Partial<CronJob> = {}): CronJob {
  const { state, ...jobOverrides } = overrides;
  return {
    id: "test-job",
    name: "test job",
    enabled: true,
    schedule: { expr: "0 8 * * *", kind: "cron", tz: "UTC" },
    payload: { kind: "systemEvent", text: "test" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    createdAtMs: now,
    updatedAtMs: now,
    ...jobOverrides,
    state: state ? { ...state } : {},
  };
}

describe("issue #13992 regression - cron jobs skip execution", () => {
  it("should NOT recompute nextRunAtMs for past-due jobs by default", () => {
    const now = Date.now();
    const pastDue = now - 60_000; // 1 minute ago

    const job = createCronSystemEventJob(now, {
      createdAtMs: now - 3_600_000,
      state: {
        nextRunAtMs: pastDue, // This is in the past and should NOT be recomputed
      },
      updatedAtMs: now - 3_600_000,
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should not have changed the past-due nextRunAtMs
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("should recompute past-due nextRunAtMs with recomputeExpired when slot already executed", () => {
    // NOTE: in onTimer this recovery branch is used only when due scan found no
    // Runnable jobs; this unit test validates the maintenance helper contract.
    const now = Date.now();
    const pastDue = now - 60_000;

    const job = createCronSystemEventJob(now, {
      createdAtMs: now - 3_600_000,
      state: {
        lastRunAtMs: pastDue + 1000,
        nextRunAtMs: pastDue,
      },
      updatedAtMs: now - 3_600_000,
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect((job.state.nextRunAtMs ?? 0) > now).toBe(true);
  });

  it("should NOT recompute past-due nextRunAtMs for running jobs even with recomputeExpired", () => {
    const now = Date.now();
    const pastDue = now - 60_000;

    const job = createCronSystemEventJob(now, {
      createdAtMs: now - 3_600_000,
      state: {
        nextRunAtMs: pastDue,
        runningAtMs: now - 500,
      },
      updatedAtMs: now - 3_600_000,
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    expect(job.state.nextRunAtMs).toBe(pastDue);
  });

  it("should compute missing nextRunAtMs during maintenance", () => {
    const now = Date.now();

    const job = createCronSystemEventJob(now, {
      state: {
        // NextRunAtMs is missing
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have computed a nextRunAtMs
    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("should repair nextRunAtMs=0 during maintenance", () => {
    const now = Date.now();

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: 0,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    expect(typeof job.state.nextRunAtMs).toBe("number");
    expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });

  it("should clear nextRunAtMs for disabled jobs during maintenance", () => {
    const now = Date.now();
    const futureTime = now + 3_600_000;

    const job = createCronSystemEventJob(now, {
      enabled: false, // Disabled
      state: {
        nextRunAtMs: futureTime,
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have cleared nextRunAtMs for disabled job
    expect(job.state.nextRunAtMs).toBeUndefined();
  });

  it("should clear stuck running markers during maintenance", () => {
    const now = Date.now();
    const stuckTime = now - 3 * 60 * 60_000; // 3 hours ago (> 2 hour threshold)
    const futureTime = now + 3_600_000;

    const job = createCronSystemEventJob(now, {
      state: {
        nextRunAtMs: futureTime,
        runningAtMs: stuckTime, // Stuck running marker
      },
    });

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state);

    // Should have cleared stuck running marker
    expect(job.state.runningAtMs).toBeUndefined();
    // But should NOT have changed nextRunAtMs (it's still future)
    expect(job.state.nextRunAtMs).toBe(futureTime);
  });

  it("isolates schedule errors while filling missing nextRunAtMs", () => {
    const now = Date.now();
    const pastDue = now - 1000;

    const dueJob: CronJob = {
      createdAtMs: now - 3_600_000,
      enabled: true,
      id: "due-job",
      name: "due job",
      payload: { kind: "systemEvent", text: "due" },
      schedule: { expr: "0 8 * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      state: {
        nextRunAtMs: pastDue,
      },
      updatedAtMs: now - 3_600_000,
      wakeMode: "next-heartbeat",
    };

    const malformedJob: CronJob = {
      createdAtMs: now - 3_600_000,
      enabled: true,
      id: "bad-job",
      name: "bad job",
      payload: { kind: "systemEvent", text: "bad" },
      schedule: { expr: "not a valid cron", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      state: {
        // Missing nextRunAtMs
      },
      updatedAtMs: now - 3_600_000,
      wakeMode: "next-heartbeat",
    };

    const state = createMockCronStateForJobs({ jobs: [dueJob, malformedJob], nowMs: now });

    expect(() => recomputeNextRunsForMaintenance(state)).not.toThrow();
    expect(dueJob.state.nextRunAtMs).toBe(pastDue);
    expect(malformedJob.state.nextRunAtMs).toBeUndefined();
    expect(malformedJob.state.scheduleErrorCount).toBe(1);
    expect(malformedJob.state.lastError).toMatch(/^schedule error:/);
  });

  it("recomputes expired slots already executed but keeps never-executed stale slots", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const alreadyExecuted: CronJob = {
      createdAtMs: now - 86_400_000,
      enabled: true,
      id: "already-executed",
      name: "already executed",
      payload: { kind: "systemEvent", text: "done" },
      schedule: { expr: "0 8 * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      state: {
        lastRunAtMs: pastDue + 1000,
        nextRunAtMs: pastDue,
      },
      updatedAtMs: now - 86_400_000,
      wakeMode: "next-heartbeat",
    };

    const neverExecuted: CronJob = {
      createdAtMs: now - 86_400_000 * 2,
      enabled: true,
      id: "never-executed",
      name: "never executed",
      payload: { kind: "systemEvent", text: "pending" },
      schedule: { expr: "0 8 * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      state: {
        lastRunAtMs: pastDue - 86_400_000,
        nextRunAtMs: pastDue,
      },
      updatedAtMs: now - 86_400_000 * 2,
      wakeMode: "next-heartbeat",
    };

    const state = createMockCronStateForJobs({
      jobs: [alreadyExecuted, neverExecuted],
      nowMs: now,
    });
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    expect((alreadyExecuted.state.nextRunAtMs ?? 0) > now).toBe(true);
    expect(neverExecuted.state.nextRunAtMs).toBe(pastDue);
  });

  it("does not advance overdue never-executed jobs when stale running marker is cleared", () => {
    const now = Date.now();
    const pastDue = now - 60_000;
    const staleRunningAt = now - 3 * 60 * 60_000;

    const job: CronJob = {
      createdAtMs: now - 86_400_000,
      enabled: true,
      id: "stale-running-overdue",
      name: "stale running overdue",
      payload: { kind: "systemEvent", text: "test" },
      schedule: { expr: "0 8 * * *", kind: "cron", tz: "UTC" },
      sessionTarget: "main",
      state: {
        lastRunAtMs: pastDue - 3_600_000,
        nextRunAtMs: pastDue,
        runningAtMs: staleRunningAt,
      },
      updatedAtMs: now - 86_400_000,
      wakeMode: "next-heartbeat",
    };

    const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
    recomputeNextRunsForMaintenance(state, { nowMs: now, recomputeExpired: true });

    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(pastDue);
  });
});
