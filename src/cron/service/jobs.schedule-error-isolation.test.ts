import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob, CronStoreFile } from "../types.js";
import { recomputeNextRuns } from "./jobs.js";
import type { CronServiceState } from "./state.js";

function createMockState(jobs: CronJob[]): CronServiceState {
  const store: CronStoreFile = { jobs, version: 1 };
  return {
    deps: {
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      nowMs: () => Date.now(),
      onEvent: vi.fn(),
      persistence: {
        read: vi.fn(),
        write: vi.fn(),
      },
      requestHeartbeatNow: vi.fn(),
      runHeartbeatOnce: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    },
    running: false,
    store,
    timer: null,
  } as unknown as CronServiceState;
}

function createJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job-1",
    name: "Test Job",
    enabled: true,
    createdAtMs: Date.now() - 100_000,
    updatedAtMs: Date.now() - 100_000,
    schedule: { expr: "0 * * * *", kind: "cron" }, // Every hour
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "test" },
    state: {},
    ...overrides,
  };
}

describe("cron schedule error isolation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T10:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues processing other jobs when one has a malformed schedule", () => {
    const goodJob1 = createJob({ id: "good-1", name: "Good Job 1" });
    const badJob = createJob({
      id: "bad-job",
      name: "Bad Job",
      schedule: { expr: "invalid cron expression", kind: "cron" },
    });
    const goodJob2 = createJob({ id: "good-2", name: "Good Job 2" });

    const state = createMockState([goodJob1, badJob, goodJob2]);

    const changed = recomputeNextRuns(state);

    expect(changed).toBe(true);
    // Good jobs should have their nextRunAtMs computed
    expect(goodJob1.state.nextRunAtMs).toBeDefined();
    expect(goodJob2.state.nextRunAtMs).toBeDefined();
    // Bad job should have undefined nextRunAtMs and an error recorded
    expect(badJob.state.nextRunAtMs).toBeUndefined();
    expect(badJob.state.lastError).toMatch(/schedule error/);
    expect(badJob.state.scheduleErrorCount).toBe(1);
    // Job should still be enabled after first error
    expect(badJob.enabled).toBe(true);
  });

  it("logs a warning for the first schedule error", () => {
    const badJob = createJob({
      id: "bad-job",
      name: "Bad Job",
      schedule: { expr: "not valid", kind: "cron" },
    });
    const state = createMockState([badJob]);

    recomputeNextRuns(state);

    expect(state.deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCount: 1,
        jobId: "bad-job",
        name: "Bad Job",
      }),
      expect.stringContaining("failed to compute next run"),
    );
  });

  it("auto-disables job after 3 consecutive schedule errors", () => {
    const badJob = createJob({
      id: "bad-job",
      name: "Bad Job",
      schedule: { expr: "garbage", kind: "cron" },
      state: { scheduleErrorCount: 2 }, // Already had 2 errors
    });
    const state = createMockState([badJob]);

    recomputeNextRuns(state);

    // After 3rd error, job should be disabled
    expect(badJob.enabled).toBe(false);
    expect(badJob.state.scheduleErrorCount).toBe(3);
    expect(state.deps.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCount: 3,
        jobId: "bad-job",
        name: "Bad Job",
      }),
      expect.stringContaining("auto-disabled job"),
    );
  });

  it("clears scheduleErrorCount when schedule computation succeeds", () => {
    const job = createJob({
      id: "recovering-job",
      name: "Recovering Job",
      schedule: { expr: "0 * * * *", kind: "cron" }, // Valid
      state: { scheduleErrorCount: 2 }, // Had previous errors
    });
    const state = createMockState([job]);

    const changed = recomputeNextRuns(state);

    expect(changed).toBe(true);
    expect(job.state.nextRunAtMs).toBeDefined();
    expect(job.state.scheduleErrorCount).toBeUndefined();
  });

  it("does not modify disabled jobs", () => {
    const disabledBadJob = createJob({
      enabled: false,
      id: "disabled-bad",
      name: "Disabled Bad Job",
      schedule: { expr: "invalid", kind: "cron" },
    });
    const state = createMockState([disabledBadJob]);

    recomputeNextRuns(state);

    // Should not attempt to compute schedule for disabled jobs
    expect(disabledBadJob.state.scheduleErrorCount).toBeUndefined();
    expect(state.deps.log.warn).not.toHaveBeenCalled();
  });

  it("increments error count on each failed computation", () => {
    const badJob = createJob({
      id: "bad-job",
      name: "Bad Job",
      schedule: { expr: "@@@@", kind: "cron" },
      state: { scheduleErrorCount: 1 },
    });
    const state = createMockState([badJob]);

    recomputeNextRuns(state);

    expect(badJob.state.scheduleErrorCount).toBe(2);
    expect(badJob.enabled).toBe(true); // Not yet at threshold
  });

  it("stores error message in lastError", () => {
    const badJob = createJob({
      id: "bad-job",
      name: "Bad Job",
      schedule: { expr: "invalid expression here", kind: "cron" },
    });
    const state = createMockState([badJob]);

    recomputeNextRuns(state);

    expect(badJob.state.lastError).toMatch(/^schedule error:/);
    expect(badJob.state.lastError).toBeTruthy();
  });

  it("records a clear schedule error when cron expr is missing", () => {
    const badJob = createJob({
      id: "missing-expr",
      name: "Missing Expr",
      schedule: { kind: "cron" } as unknown as CronJob["schedule"],
    });
    const state = createMockState([badJob]);

    recomputeNextRuns(state);

    expect(badJob.state.lastError).toContain("invalid cron schedule: expr is required");
    expect(badJob.state.lastError).not.toContain("Cannot read properties of undefined");
    expect(badJob.state.scheduleErrorCount).toBe(1);
  });
});
