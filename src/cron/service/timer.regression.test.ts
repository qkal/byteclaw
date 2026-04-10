import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createDefaultIsolatedRunner,
  createDeferred,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  noopLogger,
  setupCronRegressionFixtures,
  writeCronJobs,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import * as schedule from "../schedule.js";
import type { CronJob } from "../types.js";
import { computeJobNextRunAtMs } from "./jobs.js";
import { type CronEvent, createCronServiceState } from "./state.js";
import {
  DEFAULT_JOB_TIMEOUT_MS,
  applyJobResult,
  executeJob,
  executeJobCore,
  onTimer,
  runMissedJobs,
} from "./timer.js";

const FAST_TIMEOUT_SECONDS = 0.0025;
const timerRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-timer-regressions-",
});

describe("cron service timer regressions", () => {
  it("caps timer delay to 60s for far-future schedules", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = timerRegressionFixtures.makeStorePath();
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      storePath: store.storePath,
    });

    state.store = { jobs: [], version: 1 };
    await fs.writeFile(store.storePath, JSON.stringify(state.store), "utf8");

    state.store.jobs.push({
      createdAtMs: Date.now(),
      enabled: true,
      id: "far-future",
      name: "far-future",
      payload: { kind: "systemEvent", text: "future" },
      schedule: { at: "2035-01-01T00:00:00.000Z", kind: "at" },
      sessionTarget: "main",
      state: { nextRunAtMs: Date.parse("2035-01-01T00:00:00.000Z") },
      updatedAtMs: Date.now(),
      wakeMode: "next-heartbeat",
    });

    await onTimer(state);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays).toContain(60_000);
    timeoutSpy.mockRestore();
  });

  it("re-arms timer without hot-looping when a run is already in progress", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const store = timerRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const state = createRunningCronServiceState({
      jobs: [createDueIsolatedJob({ id: "due", nextRunAtMs: now - 1, nowMs: now })],
      log: noopLogger,
      nowMs: () => now,
      storePath: store.storePath,
    });

    await onTimer(state);

    expect(timeoutSpy).toHaveBeenCalled();
    expect(state.timer).not.toBeNull();
    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d): d is number => typeof d === "number");
    expect(delays).toContain(60_000);
    timeoutSpy.mockRestore();
  });

  it("#24355: one-shot job retries then succeeds", async () => {
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const runRetryScenario = async (params: {
      id: string;
      deleteAfterRun: boolean;
      firstError?: string;
    }) => {
      const store = timerRegressionFixtures.makeStorePath();
      const cronJob = createIsolatedRegressionJob({
        id: params.id,
        name: "reminder",
        payload: { kind: "agentTurn", message: "remind me" },
        schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
        scheduledAt,
        state: { nextRunAtMs: scheduledAt },
      });
      cronJob.deleteAfterRun = params.deleteAfterRun;
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const runIsolatedAgentJob = vi
        .fn()
        .mockResolvedValueOnce({
          error: params.firstError ?? "429 rate limit exceeded",
          status: "error",
        })
        .mockResolvedValueOnce({ status: "ok", summary: "done" });
      const state = createCronServiceState({
        cronEnabled: true,
        enqueueSystemEvent: vi.fn(),
        log: noopLogger,
        nowMs: () => now,
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob,
        storePath: store.storePath,
      });

      await onTimer(state);
      const jobAfterRetry = state.store?.jobs.find((j) => j.id === params.id);
      expect(jobAfterRetry).toBeDefined();
      expect(jobAfterRetry!.enabled).toBe(true);
      expect(jobAfterRetry!.state.lastStatus).toBe("error");
      expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

      now = (jobAfterRetry!.state.nextRunAtMs ?? 0) + 1;
      await onTimer(state);
      return { runIsolatedAgentJob, state };
    };

    const keepResult = await runRetryScenario({
      deleteAfterRun: false,
      id: "oneshot-retry",
    });
    const keepJob = keepResult.state.store?.jobs.find((j) => j.id === "oneshot-retry");
    expect(keepJob?.state.lastStatus).toBe("ok");
    expect(keepResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);

    const deleteResult = await runRetryScenario({
      deleteAfterRun: true,
      id: "oneshot-deleteAfterRun-retry",
    });
    const deletedJob = deleteResult.state.store?.jobs.find(
      (j) => j.id === "oneshot-deleteAfterRun-retry",
    );
    expect(deletedJob).toBeUndefined();
    expect(deleteResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);

    const overloadedResult = await runRetryScenario({
      deleteAfterRun: false,
      firstError:
        "All models failed (2): anthropic/claude-3-5-sonnet: LLM error overloaded_error: overloaded (overloaded); openai/gpt-5.4: LLM error overloaded_error: overloaded (overloaded)",
      id: "oneshot-overloaded-retry",
    });
    const overloadedJob = overloadedResult.state.store?.jobs.find(
      (j) => j.id === "oneshot-overloaded-retry",
    );
    expect(overloadedJob?.state.lastStatus).toBe("ok");
    expect(overloadedResult.runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#24355: one-shot job disabled after max transient retries", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-max-retries",
      name: "reminder",
      payload: { kind: "agentTurn", message: "remind me" },
      schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      error: "429 rate limit exceeded",
      status: "error",
    });
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    for (let i = 0; i < 4; i += 1) {
      await onTimer(state);
      const job = state.store?.jobs.find((j) => j.id === "oneshot-max-retries");
      expect(job).toBeDefined();
      if (i < 3) {
        expect(job!.enabled).toBe(true);
        now = (job!.state.nextRunAtMs ?? now) + 1;
      } else {
        expect(job!.enabled).toBe(false);
      }
    }
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(4);
  });

  it("#24355: one-shot job respects cron.retry config", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-custom-retry",
      name: "reminder",
      payload: { kind: "agentTurn", message: "remind me" },
      schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi.fn().mockResolvedValue({
      error: "429 rate limit exceeded",
      status: "error",
    });
    const state = createCronServiceState({
      cronConfig: {
        retry: { backoffMs: [1000, 2000], maxAttempts: 2 },
      },
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    for (let i = 0; i < 4; i += 1) {
      await onTimer(state);
      const job = state.store?.jobs.find((j) => j.id === "oneshot-custom-retry");
      expect(job).toBeDefined();
      if (i < 2) {
        expect(job!.enabled).toBe(true);
        now = (job!.state.nextRunAtMs ?? now) + 1;
      } else {
        expect(job!.enabled).toBe(false);
      }
    }
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(3);
  });

  it("#24355: one-shot job retries status-only 529 failures when retryOn only includes overloaded", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-overloaded-529-only",
      name: "reminder",
      payload: { kind: "agentTurn", message: "remind me" },
      schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({ error: "FailoverError: HTTP 529", status: "error" })
      .mockResolvedValueOnce({ status: "ok", summary: "done" });
    const state = createCronServiceState({
      cronConfig: {
        retry: { backoffMs: [1000], maxAttempts: 1, retryOn: ["overloaded"] },
      },
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    await onTimer(state);
    const jobAfterRetry = state.store?.jobs.find((j) => j.id === "oneshot-overloaded-529-only");
    expect(jobAfterRetry!.enabled).toBe(true);
    expect(jobAfterRetry!.state.lastStatus).toBe("error");
    expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = (jobAfterRetry!.state.nextRunAtMs ?? now) + 1;
    await onTimer(state);

    const finishedJob = state.store?.jobs.find((j) => j.id === "oneshot-overloaded-529-only");
    expect(finishedJob!.state.lastStatus).toBe("ok");
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#38822: one-shot job retries Bedrock too-many-tokens-per-day errors", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-03-08T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-bedrock-too-many-tokens-per-day",
      name: "reminder",
      payload: { kind: "agentTurn", message: "remind me" },
      schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({
        error: "AWS Bedrock: Too many tokens per day. Please try again tomorrow.",
        status: "error",
      })
      .mockResolvedValueOnce({ status: "ok", summary: "done" });
    const state = createCronServiceState({
      cronConfig: {
        retry: { backoffMs: [1000], maxAttempts: 1, retryOn: ["rate_limit"] },
      },
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    await onTimer(state);
    const jobAfterRetry = state.store?.jobs.find(
      (j) => j.id === "oneshot-bedrock-too-many-tokens-per-day",
    );
    expect(jobAfterRetry!.enabled).toBe(true);
    expect(jobAfterRetry!.state.lastStatus).toBe("error");
    expect(jobAfterRetry!.state.nextRunAtMs).toBeGreaterThan(scheduledAt);

    now = (jobAfterRetry!.state.nextRunAtMs ?? now) + 1;
    await onTimer(state);

    const finishedJob = state.store?.jobs.find(
      (j) => j.id === "oneshot-bedrock-too-many-tokens-per-day",
    );
    expect(finishedJob!.state.lastStatus).toBe("ok");
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
  });

  it("#24355: one-shot job disabled immediately on permanent error", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-06T10:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "oneshot-permanent-error",
      name: "reminder",
      payload: { kind: "agentTurn", message: "remind me" },
      schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    const now = scheduledAt;
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({
        error: "invalid API key",
        status: "error",
      }),
      storePath: store.storePath,
    });

    await onTimer(state);

    const job = state.store?.jobs.find((j) => j.id === "oneshot-permanent-error");
    expect(job!.enabled).toBe(false);
    expect(job!.state.lastStatus).toBe("error");
    expect(job!.state.nextRunAtMs).toBeUndefined();
  });

  it("prevents spin loop when cron job completes within the scheduled second (#17821)", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const nextDay = scheduledAt + 86_400_000;

    const cronJob = createIsolatedRegressionJob({
      id: "spin-loop-17821",
      name: "daily noon",
      payload: { kind: "agentTurn", message: "briefing" },
      schedule: { expr: "0 13 * * *", kind: "cron", tz: "UTC" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    let fireCount = 0;
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 7;
        fireCount += 1;
        return { status: "ok" as const, summary: "done" };
      }),
      storePath: store.storePath,
    });

    await onTimer(state);
    expect(fireCount).toBe(1);

    const job = state.store?.jobs.find((entry) => entry.id === "spin-loop-17821");
    expect(job!.state.nextRunAtMs).toBeGreaterThanOrEqual(nextDay);

    await onTimer(state);
    expect(fireCount).toBe(1);
  });

  it("enforces a minimum refire gap for second-granularity cron schedules (#17821)", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "spin-gap-17821",
      name: "second-granularity",
      payload: { kind: "agentTurn", message: "pulse" },
      schedule: { expr: "* * * * * *", kind: "cron", tz: "UTC" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 100;
        return { status: "ok" as const, summary: "done" };
      }),
      storePath: store.storePath,
    });

    await onTimer(state);

    const job = state.store?.jobs.find((entry) => entry.id === "spin-gap-17821");
    const endedAt = now;
    expect(job!.state.nextRunAtMs).toBeGreaterThanOrEqual(endedAt + 2000);
  });

  it("treats timeoutSeconds=0 as no timeout for isolated agentTurn jobs", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "no-timeout-0",
      name: "no-timeout",
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: 0 },
      schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        const result = await deferredRun.promise;
        now += 5;
        return result;
      }),
      storePath: store.storePath,
    });

    const timerPromise = onTimer(state);
    let settled = false;
    void timerPromise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    deferredRun.resolve({ status: "ok", summary: "done" });
    await timerPromise;

    const job = state.store?.jobs.find((entry) => entry.id === "no-timeout-0");
    expect(job?.state.lastStatus).toBe("ok");
  });

  it("does not time out agentTurn jobs at the default 10-minute safety window", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");

    const cronJob = createIsolatedRegressionJob({
      id: "agentturn-default-safety-window",
      name: "agentturn default safety window",
      payload: { kind: "agentTurn", message: "work" },
      schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [cronJob]);

    let now = scheduledAt;
    const deferredRun = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      const result = await deferredRun.promise;
      if (abortSignal?.aborted) {
        return { error: String(abortSignal.reason), status: "error" as const };
      }
      now += 5;
      return result;
    });
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    const timerPromise = onTimer(state);
    let settled = false;
    void timerPromise.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_JOB_TIMEOUT_MS + 1000);
    await Promise.resolve();
    expect(settled).toBe(false);

    deferredRun.resolve({ status: "ok", summary: "done" });
    await timerPromise;

    const job = state.store?.jobs.find((entry) => entry.id === "agentturn-default-safety-window");
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.lastError).toBeUndefined();
  });

  it("aborts isolated runs when cron timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "abort-on-timeout",
        name: "abort timeout",
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
        scheduledAt,
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const abortAwareRunner = createAbortAwareIsolatedRunner();
      const state = createCronServiceState({
        cronEnabled: true,
        enqueueSystemEvent: vi.fn(),
        log: noopLogger,
        nowMs: () => now,
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await abortAwareRunner.runIsolatedAgentJob(params);
          now += 5;
          return result;
        }),
        storePath: store.storePath,
      });

      const timerPromise = onTimer(state);
      await abortAwareRunner.waitForStart();
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1000) + 10);
      await timerPromise;

      expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);
      const job = state.store?.jobs.find((entry) => entry.id === "abort-on-timeout");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses isolated follow-up side effects after timeout", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const enqueueSystemEvent = vi.fn();

      const cronJob = createIsolatedRegressionJob({
        id: "timeout-side-effects",
        name: "timeout side effects",
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        schedule: { anchorMs: scheduledAt, everyMs: 60_000, kind: "every" },
        scheduledAt,
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const abortAwareRunner = createAbortAwareIsolatedRunner("late-summary");
      const state = createCronServiceState({
        cronEnabled: true,
        enqueueSystemEvent,
        log: noopLogger,
        nowMs: () => now,
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await abortAwareRunner.runIsolatedAgentJob(params);
          now += 100;
          return result;
        }),
        storePath: store.storePath,
      });

      const timerPromise = onTimer(state);
      await abortAwareRunner.waitForStart();
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1000) + 10);
      await timerPromise;

      const jobAfterTimeout = state.store?.jobs.find(
        (entry) => entry.id === "timeout-side-effects",
      );
      expect(jobAfterTimeout?.state.lastStatus).toBe("error");
      expect(jobAfterTimeout?.state.lastError).toContain("timed out");
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies timeoutSeconds to startup catch-up isolated executions", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const cronJob = createIsolatedRegressionJob({
        id: "startup-timeout",
        name: "startup timeout",
        payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
        schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
        scheduledAt,
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      let now = scheduledAt;
      const abortAwareRunner = createAbortAwareIsolatedRunner();
      const state = createCronServiceState({
        cronEnabled: true,
        enqueueSystemEvent: vi.fn(),
        log: noopLogger,
        nowMs: () => now,
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async (params) => {
          const result = await abortAwareRunner.runIsolatedAgentJob(params);
          now += 5;
          return result;
        }),
        storePath: store.storePath,
      });

      const catchupPromise = runMissedJobs(state);
      await abortAwareRunner.waitForStart();
      await vi.advanceTimersByTimeAsync(Math.ceil(FAST_TIMEOUT_SECONDS * 1000) + 10);
      await catchupPromise;

      expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);
      const job = state.store?.jobs.find((entry) => entry.id === "startup-timeout");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects abort signals while retrying one-shot main-session wake-now heartbeat runs", async () => {
    const abortController = new AbortController();
    const runHeartbeatOnce = vi.fn(
      async (): Promise<HeartbeatRunResult> => ({
        reason: "requests-in-flight",
        status: "skipped",
      }),
    );
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const mainJob: CronJob = {
      createdAtMs: Date.now(),
      enabled: true,
      id: "main-abort",
      name: "main abort",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), kind: "at" },
      sessionTarget: "main",
      state: {},
      updatedAtMs: Date.now(),
      wakeMode: "now",
    };
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      nowMs: () => Date.now(),
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      storePath: "/tmp/openclaw-cron-abort-test/jobs.json",
      wakeNowHeartbeatBusyMaxWaitMs: 30,
      wakeNowHeartbeatBusyRetryDelayMs: 5,
    });

    setTimeout(() => {
      abortController.abort();
    }, 10);

    const resultPromise = executeJobCore(state, mainJob, abortController.signal);
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result.status).toBe("error");
    expect(result.error).toContain("timed out");
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("finishes recurring wake-now main jobs quickly when the main lane is busy (#58833)", async () => {
    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };
    const runHeartbeatOnce = vi.fn(
      async (): Promise<HeartbeatRunResult> => ({
        reason: "requests-in-flight",
        status: "skipped",
      }),
    );
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const job: CronJob = {
      createdAtMs: 0,
      enabled: true,
      id: "busy-recurring-main",
      name: "busy recurring main",
      payload: { kind: "systemEvent", text: "tick" },
      schedule: { expr: "*/3 * * * *", kind: "cron", staggerMs: 0, tz: "UTC" },
      sessionTarget: "main",
      state: { nextRunAtMs: 0 },
      updatedAtMs: 0,
      wakeMode: "now",
    };
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      nowMs,
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      storePath: "/tmp/openclaw-cron-busy-main-test/jobs.json",
      wakeNowHeartbeatBusyMaxWaitMs: 120_000,
      wakeNowHeartbeatBusyRetryDelayMs: 250,
    });
    state.store = { jobs: [job], version: 1 };

    await executeJob(state, job, nowMs(), { forced: false });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cron:busy-recurring-main" }),
    );
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDurationMs).toBeLessThan(100);
    expect(job.state.runningAtMs).toBeUndefined();
  });

  it("retries cron schedule computation from the next second when the first attempt returns undefined (#17821)", () => {
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const cronJob = createIsolatedRegressionJob({
      id: "retry-next-second-17821",
      name: "retry",
      payload: { kind: "agentTurn", message: "briefing" },
      schedule: { expr: "0 13 * * *", kind: "cron", tz: "UTC" },
      scheduledAt,
    });

    const original = schedule.computeNextRunAtMs;
    const spy = vi.spyOn(schedule, "computeNextRunAtMs");
    try {
      spy
        .mockImplementationOnce(() => undefined)
        .mockImplementation((sched, nowMs) => original(sched, nowMs));

      const expected = original(cronJob.schedule, scheduledAt + 1000);
      expect(expected).toBeDefined();

      const next = computeJobNextRunAtMs(cronJob, scheduledAt);
      expect(next).toBe(expected);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("records per-job start time and duration for batched due jobs", async () => {
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "batch-first", nextRunAtMs: dueAt, nowMs: dueAt });
    const second = createDueIsolatedJob({ id: "batch-second", nextRunAtMs: dueAt, nowMs: dueAt });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ jobs: [first, second], version: 1 }),
      "utf8",
    );

    let now = dueAt;
    const events: CronEvent[] = [];
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      onEvent: (evt) => {
        events.push(evt);
      },
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        now += params.job.id === first.id ? 50 : 20;
        return { status: "ok" as const, summary: "ok" };
      }),
      storePath: store.storePath,
    });

    await onTimer(state);

    const jobs = state.store?.jobs ?? [];
    const firstDone = jobs.find((job) => job.id === first.id);
    const secondDone = jobs.find((job) => job.id === second.id);
    const startedAtEvents = events
      .filter((evt) => evt.action === "started")
      .map((evt) => evt.runAtMs);

    expect(firstDone?.state.lastRunAtMs).toBe(dueAt);
    expect(firstDone?.state.lastDurationMs).toBe(50);
    expect(secondDone?.state.lastRunAtMs).toBe(dueAt + 50);
    expect(secondDone?.state.lastDurationMs).toBe(20);
    expect(startedAtEvents).toEqual([dueAt, dueAt + 50]);
  });

  it("honors cron maxConcurrentRuns for due jobs", async () => {
    vi.useRealTimers();
    const store = timerRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:01.000Z");
    const first = createDueIsolatedJob({ id: "parallel-first", nextRunAtMs: dueAt, nowMs: dueAt });
    const second = createDueIsolatedJob({
      id: "parallel-second",
      nextRunAtMs: dueAt,
      nowMs: dueAt,
    });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ jobs: [first, second], version: 1 }),
      "utf8",
    );

    let now = dueAt;
    let activeRuns = 0;
    let peakActiveRuns = 0;
    const bothRunsStarted = createDeferred<void>();
    const firstRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondRun = createDeferred<{ status: "ok"; summary: string }>();
    const state = createCronServiceState({
      cronConfig: { maxConcurrentRuns: 2 },
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async (params: { job: { id: string } }) => {
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        if (peakActiveRuns >= 2) {
          bothRunsStarted.resolve();
        }
        try {
          const result =
            params.job.id === first.id ? await firstRun.promise : await secondRun.promise;
          now += 10;
          return result;
        } finally {
          activeRuns -= 1;
        }
      }),
      storePath: store.storePath,
    });

    const timerPromise = onTimer(state);
    const startTimeout = setTimeout(() => {
      bothRunsStarted.reject(new Error("timed out waiting for concurrent job starts"));
    }, 250);
    try {
      await bothRunsStarted.promise;
    } finally {
      clearTimeout(startTimeout);
    }

    expect(peakActiveRuns).toBe(2);

    firstRun.resolve({ status: "ok", summary: "first done" });
    secondRun.resolve({ status: "ok", summary: "second done" });
    await timerPromise;

    const jobs = state.store?.jobs ?? [];
    expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("ok");
    expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");
  });

  it("outer cron timeout fires at configured timeoutSeconds, not at 1/3 (#29774)", async () => {
    vi.useFakeTimers();
    try {
      const store = timerRegressionFixtures.makeStorePath();
      const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
      const timeoutSeconds = 0.03;
      const cronJob = createIsolatedRegressionJob({
        id: "timeout-fraction-29774",
        name: "timeout fraction regression",
        payload: { kind: "agentTurn", message: "work", timeoutSeconds },
        schedule: { at: new Date(scheduledAt).toISOString(), kind: "at" },
        scheduledAt,
        state: { nextRunAtMs: scheduledAt },
      });
      await writeCronJobs(store.storePath, [cronJob]);

      vi.setSystemTime(scheduledAt);
      let now = scheduledAt;
      const wallStart = Date.now();
      let abortWallMs: number | undefined;
      const started = createDeferred<void>();

      const state = createCronServiceState({
        cronEnabled: true,
        enqueueSystemEvent: vi.fn(),
        log: noopLogger,
        nowMs: () => now,
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob: vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (!abortSignal) {
              resolve();
              return;
            }
            if (abortSignal.aborted) {
              abortWallMs = Date.now();
              resolve();
              return;
            }
            abortSignal.addEventListener(
              "abort",
              () => {
                abortWallMs = Date.now();
                resolve();
              },
              { once: true },
            );
          });
          now += 5;
          return { status: "ok" as const, summary: "done" };
        }),
        storePath: store.storePath,
      });

      const timerPromise = onTimer(state);
      await started.promise;

      await vi.advanceTimersByTimeAsync(15);
      expect(abortWallMs).toBeUndefined();

      await vi.advanceTimersByTimeAsync(20);
      await timerPromise;

      const elapsedMs = (abortWallMs ?? Date.now()) - wallStart;
      expect(elapsedMs).toBeGreaterThanOrEqual(timeoutSeconds * 1000);

      const job = state.store?.jobs.find((entry) => entry.id === "timeout-fraction-29774");
      expect(job?.state.lastStatus).toBe("error");
      expect(job?.state.lastError).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps state updates when cron next-run computation throws after a successful run (#30905)", () => {
    const startedAt = Date.parse("2026-03-02T12:00:00.000Z");
    const endedAt = startedAt + 50;
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => endedAt,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      storePath: "/tmp/cron-30905-success.json",
    });
    const job = createIsolatedRegressionJob({
      id: "apply-result-success-30905",
      name: "apply-result-success-30905",
      payload: { kind: "agentTurn", message: "ping" },
      schedule: { expr: "0 7 * * *", kind: "cron", tz: "Invalid/Timezone" },
      scheduledAt: startedAt,
      state: { nextRunAtMs: startedAt - 1000, runningAtMs: startedAt - 500 },
    });

    const shouldDelete = applyJobResult(state, job, {
      delivered: true,
      endedAt,
      startedAt,
      status: "ok",
    });

    expect(shouldDelete).toBe(false);
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.scheduleErrorCount).toBe(1);
    expect(job.state.lastError).toMatch(/^schedule error:/);
    expect(job.state.nextRunAtMs).toBe(endedAt + 2000);
    expect(job.enabled).toBe(true);
  });

  it("falls back to backoff schedule when cron next-run computation throws on error path (#30905)", () => {
    const startedAt = Date.parse("2026-03-02T12:05:00.000Z");
    const endedAt = startedAt + 25;
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => endedAt,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      storePath: "/tmp/cron-30905-error.json",
    });
    const job = createIsolatedRegressionJob({
      id: "apply-result-error-30905",
      name: "apply-result-error-30905",
      payload: { kind: "agentTurn", message: "ping" },
      schedule: { expr: "0 7 * * *", kind: "cron", tz: "Invalid/Timezone" },
      scheduledAt: startedAt,
      state: { nextRunAtMs: startedAt - 1000, runningAtMs: startedAt - 500 },
    });

    const shouldDelete = applyJobResult(state, job, {
      endedAt,
      error: "synthetic failure",
      startedAt,
      status: "error",
    });

    expect(shouldDelete).toBe(false);
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.lastStatus).toBe("error");
    expect(job.state.consecutiveErrors).toBe(1);
    expect(job.state.scheduleErrorCount).toBe(1);
    expect(job.state.lastError).toMatch(/^schedule error:/);
    expect(job.state.nextRunAtMs).toBe(endedAt + 30_000);
    expect(job.enabled).toBe(true);
  });

  it("force run preserves 'every' anchor while recording manual lastRunAtMs", () => {
    const nowMs = Date.now();
    const everyMs = 24 * 60 * 60 * 1000;
    const lastScheduledRunMs = nowMs - 6 * 60 * 60 * 1000;
    const expectedNextMs = lastScheduledRunMs + everyMs;

    const job: CronJob = {
      createdAtMs: lastScheduledRunMs - everyMs,
      enabled: true,
      id: "daily-job",
      name: "Daily job",
      payload: { kind: "systemEvent", text: "daily check-in" },
      schedule: { anchorMs: lastScheduledRunMs - everyMs, everyMs, kind: "every" },
      sessionTarget: "main",
      state: {
        lastRunAtMs: lastScheduledRunMs,
        nextRunAtMs: expectedNextMs,
      },
      updatedAtMs: lastScheduledRunMs,
      wakeMode: "next-heartbeat",
    };
    const state = createRunningCronServiceState({
      jobs: [job],
      log: noopLogger,
      nowMs: () => nowMs,
      storePath: "/tmp/cron-force-run-anchor-test.json",
    });

    const startedAt = nowMs;
    const endedAt = nowMs + 2000;

    applyJobResult(state, job, { endedAt, startedAt, status: "ok" }, { preserveSchedule: true });

    expect(job.state.lastRunAtMs).toBe(startedAt);
    expect(job.state.nextRunAtMs).toBe(expectedNextMs);
  });
});
