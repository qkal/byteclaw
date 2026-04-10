import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createAbortAwareIsolatedRunner,
  createDeferred,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  noopLogger,
  setupCronRegressionFixtures,
  writeCronJobs,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  clearCommandLane,
  setCommandLaneConcurrency,
  waitForActiveTasks,
} from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { enqueueRun, run } from "./ops.js";
import type { CronEvent } from "./state.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.js";

const FAST_TIMEOUT_SECONDS = 0.0025;
const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-ops-regressions-",
});

describe("cron service ops regressions", () => {
  it("skips forced manual runs while a timer-triggered run is in progress", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.now() - 1;
    const job = createIsolatedRegressionJob({
      id: "timer-overlap",
      name: "timer-overlap",
      payload: { kind: "agentTurn", message: "long task" },
      schedule: { at: new Date(dueAt).toISOString(), kind: "at" },
      scheduledAt: dueAt,
      state: { nextRunAtMs: dueAt },
    });
    await writeCronJobs(store.storePath, [job]);

    let resolveRun:
      | ((value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void)
      | undefined;
    const started = createDeferred<void>();
    const finished = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(
      async () =>
        await new Promise<{ status: "ok" | "error" | "skipped"; summary?: string; error?: string }>(
          (resolve) => {
            resolveRun = resolve;
          },
        ),
    );

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      onEvent: (evt: CronEvent) => {
        if (evt.jobId !== job.id) {
          return;
        }
        if (evt.action === "started") {
          started.resolve();
        } else if (evt.action === "finished" && evt.status === "ok") {
          finished.resolve();
        }
      },
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    const timerPromise = onTimer(state);
    await started.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    const manualResult = await run(state, job.id, "force");
    expect(manualResult).toEqual({ ok: true, ran: false, reason: "already-running" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    resolveRun?.({ status: "ok", summary: "done" });
    await finished.promise;
    await timerPromise;
  });

  it("does not double-run a job when cron.run overlaps a due timer tick", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createIsolatedRegressionJob({
      id: "manual-overlap-no-double-run",
      name: "manual overlap no double run",
      payload: { kind: "agentTurn", message: "overlap" },
      schedule: { at: new Date(now).toISOString(), kind: "at" },
      scheduledAt: now,
      state: { nextRunAtMs: now },
    });
    await writeCronJobs(store.storePath, [job]);

    const runStarted = createDeferred<void>();
    const runFinished = createDeferred<void>();
    const runResolvers: ((value: {
      status: "ok" | "error" | "skipped";
      summary?: string;
    }) => void)[] = [];
    const runIsolatedAgentJob = vi.fn(async () => {
      if (runIsolatedAgentJob.mock.calls.length === 1) {
        runStarted.resolve();
      }
      return await new Promise<{ status: "ok" | "error" | "skipped"; summary?: string }>(
        (resolve) => {
          runResolvers.push(resolve);
        },
      );
    });

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      onEvent: (evt: CronEvent) => {
        if (evt.jobId === job.id && evt.action === "finished") {
          runFinished.resolve();
        }
      },
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    const manualRun = run(state, job.id, "force");
    await runStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    await onTimer(state);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    runResolvers[0]?.({ status: "ok", summary: "done" });
    await manualRun;
    await runFinished.promise;
  });

  it("manual cron.run preserves unrelated due jobs but advances already-executed stale slots", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const dueNextRunAtMs = nowMs - 1000;
    const staleExecutedNextRunAtMs = nowMs - 2000;

    await writeCronJobs(store.storePath, [
      createIsolatedRegressionJob({
        id: "manual-target",
        name: "manual target",
        payload: { kind: "agentTurn", message: "manual target" },
        schedule: { at: new Date(nowMs + 3_600_000).toISOString(), kind: "at" },
        scheduledAt: nowMs,
        state: { nextRunAtMs: nowMs + 3_600_000 },
      }),
      createIsolatedRegressionJob({
        id: "unrelated-due",
        name: "unrelated due",
        payload: { kind: "agentTurn", message: "unrelated due" },
        schedule: { expr: "*/5 * * * *", kind: "cron", tz: "UTC" },
        scheduledAt: nowMs,
        state: { nextRunAtMs: dueNextRunAtMs },
      }),
      createIsolatedRegressionJob({
        id: "unrelated-stale-executed",
        name: "unrelated stale executed",
        payload: { kind: "agentTurn", message: "unrelated stale executed" },
        schedule: { expr: "*/5 * * * *", kind: "cron", tz: "UTC" },
        scheduledAt: nowMs,
        state: {
          lastRunAtMs: staleExecutedNextRunAtMs + 1,
          nextRunAtMs: staleExecutedNextRunAtMs,
        },
      }),
    ]);

    const state = createCronServiceState({
      cronEnabled: false,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
      storePath: store.storePath,
    });

    const runResult = await run(state, "manual-target", "force");
    expect(runResult).toEqual({ ok: true, ran: true });

    const jobs = state.store?.jobs ?? [];
    const unrelated = jobs.find((entry) => entry.id === "unrelated-due");
    const staleExecuted = jobs.find((entry) => entry.id === "unrelated-stale-executed");
    expect(unrelated?.state.nextRunAtMs).toBe(dueNextRunAtMs);
    expect((staleExecuted?.state.nextRunAtMs ?? 0) > nowMs).toBe(true);
  });

  it("applies timeoutSeconds to manual cron.run isolated executions", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const scheduledAt = Date.parse("2026-02-15T13:00:00.000Z");
    const job = createIsolatedRegressionJob({
      id: "manual-timeout",
      name: "manual timeout",
      payload: { kind: "agentTurn", message: "work", timeoutSeconds: FAST_TIMEOUT_SECONDS },
      schedule: { anchorMs: scheduledAt, everyMs: 60_000, kind: "every" },
      scheduledAt,
      state: { nextRunAtMs: scheduledAt },
    });
    await writeCronJobs(store.storePath, [job]);

    const abortAwareRunner = createAbortAwareIsolatedRunner();
    const state = createCronServiceState({
      cronEnabled: false,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: abortAwareRunner.runIsolatedAgentJob,
      storePath: store.storePath,
    });

    const resultPromise = run(state, job.id, "force");
    await abortAwareRunner.waitForStart();
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;
    expect(result).toEqual({ ok: true, ran: true });
    expect(abortAwareRunner.getObservedAbortSignal()?.aborted).toBe(true);

    const updated = state.store?.jobs.find((entry) => entry.id === job.id);
    expect(updated?.state.lastStatus).toBe("error");
    expect(updated?.state.lastError).toContain("timed out");
    expect(updated?.state.runningAtMs).toBeUndefined();
  });

  it("#17554: run() clears stale runningAtMs and executes the job", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const staleRunningAtMs = now - 2 * 60 * 60 * 1000 - 1;

    await writeCronJobs(store.storePath, [
      {
        createdAtMs: now - 3_600_000,
        enabled: true,
        id: "stale-running",
        name: "stale-running",
        payload: { kind: "systemEvent", text: "stale-running" },
        schedule: { at: new Date(now - 60_000).toISOString(), kind: "at" },
        sessionTarget: "main",
        state: {
          lastRunAtMs: now - 3_600_000,
          lastStatus: "ok",
          nextRunAtMs: now - 60_000,
          runningAtMs: staleRunningAtMs,
        },
        updatedAtMs: now - 3_600_000,
        wakeMode: "now",
      },
    ]);

    const enqueueSystemEvent = vi.fn();
    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent,
      log: noopLogger,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
      storePath: store.storePath,
    });

    const result = await run(state, "stale-running", "force");
    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "stale-running",
      expect.objectContaining({ agentId: undefined }),
    );
  });

  it("queues manual cron.run requests behind the cron execution lane", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:02.000Z");
    const first = createDueIsolatedJob({ id: "queued-first", nextRunAtMs: dueAt, nowMs: dueAt });
    const second = createDueIsolatedJob({
      id: "queued-second",
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
    const firstStarted = createDeferred<void>();
    const firstRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondRun = createDeferred<{ status: "ok"; summary: string }>();
    const secondStarted = createDeferred<void>();
    const bothFinished = createDeferred<void>();
    const runIsolatedAgentJob = vi.fn(async (params: { job: { id: string } }) => {
      activeRuns += 1;
      peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
      if (params.job.id === first.id) {
        firstStarted.resolve();
      }
      if (params.job.id === second.id) {
        secondStarted.resolve();
      }
      try {
        const result =
          params.job.id === first.id ? await firstRun.promise : await secondRun.promise;
        now += 10;
        return result;
      } finally {
        activeRuns -= 1;
      }
    });
    const state = createCronServiceState({
      cronConfig: { maxConcurrentRuns: 1 },
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      nowMs: () => now,
      onEvent: (evt) => {
        if (evt.action === "finished" && evt.jobId === second.id && evt.status === "ok") {
          bothFinished.resolve();
        }
      },
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      storePath: store.storePath,
    });

    const firstAck = await enqueueRun(state, first.id, "force");
    const secondAck = await enqueueRun(state, second.id, "force");
    expect(firstAck).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });
    expect(secondAck).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });

    await firstStarted.promise;
    expect(runIsolatedAgentJob.mock.calls[0]?.[0]).toMatchObject({ job: { id: first.id } });
    expect(peakActiveRuns).toBe(1);

    firstRun.resolve({ status: "ok", summary: "first queued run" });
    await secondStarted.promise;
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
    expect(runIsolatedAgentJob.mock.calls[1]?.[0]).toMatchObject({ job: { id: second.id } });
    expect(peakActiveRuns).toBe(1);

    secondRun.resolve({ status: "ok", summary: "second queued run" });
    await bothFinished.promise;
    await waitForActiveTasks(5000);
    const jobs = state.store?.jobs ?? [];
    expect(jobs.find((job) => job.id === first.id)?.state.lastStatus).toBe("ok");
    expect(jobs.find((job) => job.id === second.id)?.state.lastStatus).toBe("ok");

    clearCommandLane(CommandLane.Cron);
  });

  it("logs unexpected queued manual run background failures once", async () => {
    vi.useRealTimers();
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const job = createDueIsolatedJob({ id: "queued-failure", nextRunAtMs: dueAt, nowMs: dueAt });
    const errorLogged = createDeferred<void>();
    const log = {
      ...noopLogger,
      error: vi.fn<(payload: unknown, message?: string) => void>(() => {
        errorLogged.resolve();
      }),
    };
    const badStore = `${opsRegressionFixtures.makeStorePath().storePath}.dir`;
    await fs.mkdir(badStore, { recursive: true });
    const state = createRunningCronServiceState({
      jobs: [job],
      log,
      nowMs: () => dueAt,
      storePath: badStore,
    });

    const result = await enqueueRun(state, job.id, "force");
    expect(result).toEqual({ enqueued: true, ok: true, runId: expect.any(String) });

    await errorLogged.promise;
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[1]).toBe(
      "cron: queued manual run background execution failed",
    );

    clearCommandLane(CommandLane.Cron);
  });
});
