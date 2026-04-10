import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  baseTimeIso: "2025-12-13T17:00:00.000Z",
  prefix: "openclaw-cron-",
});

describe("CronService restart catch-up", () => {
  async function writeStoreJobs(storePath: string, jobs: unknown[]) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ jobs, version: 1 }, null, 2), "utf8");
  }

  function createRestartCronService(params: {
    storePath: string;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeatNow: ReturnType<typeof vi.fn>;
  }) {
    return new CronService({
      cronEnabled: true,
      enqueueSystemEvent: params.enqueueSystemEvent as never,
      log: noopLogger,
      requestHeartbeatNow: params.requestHeartbeatNow as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
      storePath: params.storePath,
    });
  }

  function createOverdueEveryJob(id: string, nextRunAtMs: number) {
    return {
      createdAtMs: nextRunAtMs - 60_000,
      enabled: true,
      id,
      name: `job-${id}`,
      payload: { kind: "systemEvent", text: `tick-${id}` },
      schedule: { anchorMs: nextRunAtMs - 60_000, everyMs: 60_000, kind: "every" },
      sessionTarget: "main",
      state: { nextRunAtMs },
      updatedAtMs: nextRunAtMs - 60_000,
      wakeMode: "next-heartbeat",
    };
  }

  async function withRestartedCron(
    jobs: unknown[],
    run: (params: {
      cron: CronService;
      enqueueSystemEvent: ReturnType<typeof vi.fn>;
      requestHeartbeatNow: ReturnType<typeof vi.fn>;
    }) => Promise<void>,
  ) {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeStoreJobs(store.storePath, jobs);

    const cron = createRestartCronService({
      enqueueSystemEvent,
      requestHeartbeatNow,
      storePath: store.storePath,
    });

    try {
      await cron.start();
      await run({ cron, enqueueSystemEvent, requestHeartbeatNow });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  }

  it("executes an overdue recurring job immediately on start", async () => {
    const dueAt = Date.parse("2025-12-13T15:00:00.000Z");
    const lastRunAt = Date.parse("2025-12-12T15:00:00.000Z");

    await withRestartedCron(
      [
        {
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          enabled: true,
          id: "restart-overdue-job",
          name: "daily digest",
          payload: { kind: "systemEvent", text: "digest now" },
          schedule: { expr: "0 15 * * *", kind: "cron", tz: "UTC" },
          sessionTarget: "main",
          state: {
            lastRunAtMs: lastRunAt,
            lastStatus: "ok",
            nextRunAtMs: dueAt,
          },
          updatedAtMs: Date.parse("2025-12-12T15:00:00.000Z"),
          wakeMode: "next-heartbeat",
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "digest now",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-overdue-job");
        expect(updated?.state.lastStatus).toBe("ok");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
        expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));
      },
    );
  });

  it("replays interrupted recurring job on first restart (#60495)", async () => {
    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await withRestartedCron(
      [
        {
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          enabled: true,
          id: "restart-stale-running",
          name: "daily stale marker",
          payload: { kind: "systemEvent", text: "resume stale marker" },
          schedule: { expr: "0 16 * * *", kind: "cron", tz: "UTC" },
          sessionTarget: "main",
          state: {
            nextRunAtMs: dueAt,
            runningAtMs: staleRunningAt,
          },
          updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
          wakeMode: "next-heartbeat",
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(noopLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: "restart-stale-running" }),
          "cron: clearing stale running marker on startup",
        );

        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "resume stale marker",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-stale-running");
        expect(updated?.state.runningAtMs).toBeUndefined();
        expect(updated?.state.lastStatus).toBe("ok");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
      },
    );
  });
  it("replays the most recent missed cron slot after restart when nextRunAtMs already advanced", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          enabled: true,
          id: "restart-missed-slot",
          name: "every ten minutes +1",
          payload: { kind: "systemEvent", text: "catch missed slot" },
          schedule: { expr: "1,11,21,31,41,51 4-20 * * *", kind: "cron", tz: "UTC" },
          sessionTarget: "main",
          state: {
            // Persisted state may already be recomputed from restart time and
            // Point to the future slot, even though 04:01 was missed.
            lastRunAtMs: Date.parse("2025-12-13T03:51:00.000Z"),
            lastStatus: "ok",
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
          },
          updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          wakeMode: "next-heartbeat",
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "catch missed slot",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-missed-slot");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T04:02:00.000Z"));
      },
    );
  });

  it("does not replay interrupted one-shot jobs on startup", async () => {
    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await withRestartedCron(
      [
        {
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          enabled: true,
          id: "restart-stale-one-shot",
          name: "one shot stale marker",
          payload: { kind: "systemEvent", text: "one-shot stale marker" },
          schedule: { at: "2025-12-13T16:00:00.000Z", kind: "at" },
          sessionTarget: "main",
          state: {
            nextRunAtMs: dueAt,
            runningAtMs: staleRunningAt,
          },
          updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
          wakeMode: "next-heartbeat",
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeatNow).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-stale-one-shot");
        expect(updated?.state.runningAtMs).toBeUndefined();
      },
    );
  });

  it("does not replay cron slot when the latest slot already ran before restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          enabled: true,
          id: "restart-no-duplicate-slot",
          name: "every ten minutes +1 no duplicate",
          payload: { kind: "systemEvent", text: "already ran" },
          schedule: { expr: "1,11,21,31,41,51 4-20 * * *", kind: "cron", tz: "UTC" },
          sessionTarget: "main",
          state: {
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastStatus: "ok",
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
          },
          updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          wakeMode: "next-heartbeat",
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeatNow).not.toHaveBeenCalled();
      },
    );
  });

  it("does not replay missed cron slots while error backoff is pending after restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          enabled: true,
          id: "restart-backoff-pending",
          name: "backoff pending",
          payload: { kind: "systemEvent", text: "do not run during backoff" },
          schedule: { expr: "* * * * *", kind: "cron", tz: "UTC" },
          sessionTarget: "main",
          state: {
            // Next retry is intentionally delayed by backoff despite a newer cron slot.
            consecutiveErrors: 4,
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastStatus: "error",
            nextRunAtMs: Date.parse("2025-12-13T04:10:00.000Z"),
          },
          updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
          wakeMode: "next-heartbeat",
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeatNow).not.toHaveBeenCalled();
      },
    );
  });

  it("replays missed cron slot after restart when error backoff has already elapsed", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          enabled: true,
          id: "restart-backoff-elapsed-replay",
          name: "backoff elapsed replay",
          payload: { kind: "systemEvent", text: "replay after backoff elapsed" },
          schedule: { expr: "1,11,21,31,41,51 4-20 * * *", kind: "cron", tz: "UTC" },
          sessionTarget: "main",
          state: {
            // Startup maintenance may already point to a future slot (04:11) even
            // Though 04:01 was missed and the 30s error backoff has elapsed.
            consecutiveErrors: 1,
            lastRunAtMs: Date.parse("2025-12-13T03:51:00.000Z"),
            lastStatus: "error",
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
          },
          updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
          wakeMode: "next-heartbeat",
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "replay after backoff elapsed",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();
      },
    );
  });

  it("reschedules deferred missed jobs from the post-catchup clock so they stay in the future", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    let now = startNow;

    await writeStoreJobs(store.storePath, [
      createOverdueEveryJob("stagger-0", startNow - 60_000),
      createOverdueEveryJob("stagger-1", startNow - 50_000),
      createOverdueEveryJob("stagger-2", startNow - 40_000),
    ]);

    const state = createCronServiceState({
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      log: noopLogger,
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5000,
      nowMs: () => now,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 6000;
        return { status: "ok" as const, summary: "ok" };
      }),
      storePath: store.storePath,
    });

    await runMissedJobs(state);

    const staggeredJobs = (state.store?.jobs ?? [])
      .filter((job) => job.id.startsWith("stagger-") && job.id !== "stagger-0")
      .toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));

    expect(staggeredJobs).toHaveLength(2);
    expect(staggeredJobs[0]?.state.nextRunAtMs).toBeGreaterThan(now);
    expect(staggeredJobs[1]?.state.nextRunAtMs).toBeGreaterThan(
      staggeredJobs[0]?.state.nextRunAtMs ?? 0,
    );
    expect(
      (staggeredJobs[1]?.state.nextRunAtMs ?? 0) - (staggeredJobs[0]?.state.nextRunAtMs ?? 0),
    ).toBe(5000);

    await store.cleanup();
  });
});
